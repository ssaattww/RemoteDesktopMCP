export type StartupDiagnosticEvent =
  | "driver_started" | "npm_ci_started" | "npm_ci_completed" | "overlay_applied" | "overlay_restored"
  | "overlay_restore_skipped" | "fixture_prepare_started" | "fixture_prepare_ready" | "fixture_initialize_started"
  | "fixture_initialize_failed" | "fixture_cleanup_started" | "fixture_cleanup_completed" | "dc_transport_configured"
  | "dc_connect_started" | "dc_connect_completed" | "dc_connect_failed" | "dc_list_tools_started"
  | "dc_list_tools_completed" | "dc_list_tools_failed" | "dc_roots_started" | "dc_roots_completed"
  | "dc_roots_failed" | "dc_ready" | "dc_transport_closed" | "dc_transport_error" | "bootstrap_started"
  | "bootstrap_entry_import_started" | "bootstrap_entry_import_succeeded" | "bootstrap_entry_import_failed"
  | "bootstrap_failed" | "test_started" | "test_completed" | "diagnostic_timeout" | "tree_termination_verified"
  | "tree_termination_unknown";
export function emitStartupDiagnostic(event: StartupDiagnosticEvent, fields?: Record<string, unknown>): void;
export function safeStartupError(error: unknown): {
  errorClass: string;
  errorCode: string;
  classification: "spawn_failure" | "entry_import_failure" | "initialize_disconnect" | "other";
};
