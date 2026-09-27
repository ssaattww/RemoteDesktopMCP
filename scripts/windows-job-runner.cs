using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WindowsJobRunner
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectBasicAccountingInformation = 1;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint WaitObject0 = 0;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, uint infoClass, ref ExtendedLimitInformation info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr hJob, uint infoClass, out BasicAccountingInformation info, uint length, IntPtr returnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint SearchPath(string path, string fileName, string extension, uint bufferLength,
        StringBuilder buffer, IntPtr filePart);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static Exception Win32Error(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static string QuoteArgument(string argument)
    {
        var output = new StringBuilder(argument.Length + 2);
        output.Append('"');
        int slashes = 0;
        foreach (char value in argument)
        {
            if (value == '\\')
            {
                slashes++;
                continue;
            }
            if (value == '"')
            {
                output.Append('\\', slashes * 2 + 1);
                output.Append('"');
                slashes = 0;
                continue;
            }
            output.Append('\\', slashes);
            slashes = 0;
            output.Append(value);
        }
        output.Append('\\', slashes * 2);
        output.Append('"');
        return output.ToString();
    }

    private static string ResolveExecutable(string executable)
    {
        var extensions = new System.Collections.Generic.List<string>();
        if (!System.IO.Path.HasExtension(executable))
        {
            string pathExt = Environment.GetEnvironmentVariable("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
            foreach (string extension in pathExt.Split(';'))
            {
                string trimmed = extension.Trim();
                if (String.Equals(trimmed, ".exe", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(trimmed, ".com", StringComparison.OrdinalIgnoreCase)) extensions.Add(trimmed);
            }
        }
        extensions.Insert(0, null);
        foreach (string extension in extensions)
        {
            var buffer = new StringBuilder(32768);
            uint length = SearchPath(null, executable, extension, (uint)buffer.Capacity, buffer, IntPtr.Zero);
            if (length > 0 && length < buffer.Capacity) return buffer.ToString();
        }
        return executable;
    }

    private static int Run(string[] args)
    {
        if (args.Length < 3) throw new ArgumentException("Invalid Job Object runner arguments.");
        string executable = args[0];
        string applicationPath = ResolveExecutable(executable);
        bool verbatim = args[1] == "1";
        int count = Int32.Parse(args[2], CultureInfo.InvariantCulture);
        if (count < 0 || args.Length != count + 3) throw new ArgumentException("Invalid Job Object runner argument count.");

        var decoded = new string[count];
        for (int index = 0; index < count; index++)
            decoded[index] = Encoding.Unicode.GetString(Convert.FromBase64String(args[index + 3]));

        var commandLine = new StringBuilder(QuoteArgument(executable));
        if (decoded.Length > 0)
        {
            commandLine.Append(' ');
            commandLine.Append(verbatim ? String.Join(" ", decoded) : String.Join(" ", Array.ConvertAll(decoded, QuoteArgument)));
        }

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw Win32Error("CreateJobObject failed");
        IntPtr process = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        try
        {
            var limit = new ExtendedLimitInformation();
            limit.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
                throw Win32Error("SetInformationJobObject failed");

            var startup = new StartupInfo();
            startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
            startup.dwFlags = StartfUseStdHandles;
            startup.hStdInput = GetStdHandle(-10);
            startup.hStdOutput = GetStdHandle(-11);
            startup.hStdError = GetStdHandle(-12);

            ProcessInformation created;
            if (!CreateProcess(applicationPath, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    CreateSuspended | CreateNoWindow, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out created))
                throw Win32Error("CreateProcess failed");
            process = created.hProcess;
            thread = created.hThread;

            if (!AssignProcessToJobObject(job, process))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process, 125);
                WaitForSingleObject(process, Infinite);
                throw new Win32Exception(error, "AssignProcessToJobObject failed");
            }
            if (ResumeThread(thread) == 0xFFFFFFFF)
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process, 125);
                WaitForSingleObject(process, Infinite);
                throw new Win32Exception(error, "ResumeThread failed");
            }

            if (WaitForSingleObject(process, Infinite) != WaitObject0) throw Win32Error("Waiting for target process failed");
            uint rootExitCode;
            if (!GetExitCodeProcess(process, out rootExitCode)) throw Win32Error("GetExitCodeProcess failed");

            // Keep this helper alive after the command root exits. Its open Job handle
            // owns descendants and makes the helper PID a reliable stop handle.
            while (true)
            {
                BasicAccountingInformation accounting;
                if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out accounting,
                        (uint)Marshal.SizeOf(typeof(BasicAccountingInformation)), IntPtr.Zero))
                    throw Win32Error("QueryInformationJobObject failed");
                if (accounting.ActiveProcesses == 0) break;
                Thread.Sleep(20);
            }
            return unchecked((int)rootExitCode);
        }
        finally
        {
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (process != IntPtr.Zero) CloseHandle(process);
            // Closing a kill-on-close Job also reclaims any remaining descendants
            // when setup fails or the runner exits unexpectedly.
            CloseHandle(job);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    private static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception error)
        {
            Console.Error.WriteLine("Owned process launch failed: " + error.Message);
            return 125;
        }
    }
}
