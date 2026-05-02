export { createCodexExec, codexExec } from './exec-provider.js';
export type { CodexExecProvider } from './exec-provider.js';

export { createCodexAppServer, codexAppServer } from './app-server/provider.js';
export type {
  CodexAppServerProvider,
  CodexAppServerModelListResult,
} from './app-server/provider.js';
export { listModels } from './app-server/list-models.js';
export type { ListModelsOptions, ListModelsResult } from './app-server/list-models.js';
export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  Thread,
  Turn,
  ThreadItem,
  UserInput,
  TurnStartParams,
  TurnStartResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartedNotification,
  TurnStartedNotification,
  TurnCompletedNotification,
  ItemStartedNotification,
  ItemCompletedNotification,
  ErrorNotification,
} from './app-server/protocol/types.js';

// Backward-compat exports
export { createCodexCli, codexCli } from './codex-cli-provider.js';
export type { CodexCliProvider } from './codex-cli-provider.js';

export type {
  CodexExecSettings,
  CodexExecProviderSettings,
  CodexExecProviderOptions,
  CodexAppServerSettings,
  CodexAppServerProviderSettings,
  CodexAppServerProviderOptions,
  CodexAppServerRequestHandlers,
  CodexAppServerSession,
  AppServerUserInput,
  AppServerThreadMode,
  CodexModelId,
  Logger,
  ReasoningEffort,
  ReasoningSummary,
  ReasoningSummaryFormat,
  ModelVerbosity,
} from './types.js';

// Backward-compat type exports
export type {
  CodexCliSettings,
  CodexCliProviderSettings,
  CodexCliProviderOptions,
} from './types.js';

export { ExecLanguageModel } from './exec-language-model.js';
export { CodexCliLanguageModel } from './codex-cli-language-model.js';

export { tool, createLocalMcpServer, createSdkMcpServer } from './tools/index.js';
export type {
  LocalTool,
  LocalToolDefinition,
  LocalMcpServer,
  LocalMcpServerOptions,
  SdkMcpServer,
  SdkMcpServerOptions,
} from './tools/index.js';

export {
  isAuthenticationError,
  isUnsupportedFeatureError,
  UnsupportedFeatureError,
} from './errors.js';

// Direct provider — talks straight to chatgpt.com/backend-api over OAuth,
// no Codex CLI binary required.
export { createCodexDirect, codexDirect } from './direct/codex-direct-provider.js';
export type { CodexDirectProvider } from './direct/codex-direct-provider.js';
export { CodexDirectLanguageModel } from './direct/codex-direct-language-model.js';
export type {
  CodexDirectSettings,
  CodexDirectProviderSettings,
  CodexDirectProviderOptions,
  CodexDirectProviderMetadata,
} from './direct/types.js';
export {
  CodexAuthManager,
  type CodexAuthManagerOptions,
  type CodexAuthSource,
  type CodexAuthValidationResult,
  type OAuthStatePersister,
} from './direct/auth-manager.js';

// OAuth flows (device-code + browser PKCE) plus auth-file helpers.
export {
  initiateDeviceAuth,
  pollDeviceAuth,
  pollDeviceAuthUntilComplete,
  startCodexOAuthFlow,
  exchangeCodeManually,
  refreshCodexToken,
  loadCodexAuth,
  saveCodexAuth,
  defaultAuthFilePath,
  extractAccountId,
  decodeJwtPayload,
  getJwtExpiryMs,
  DEFAULT_OAUTH_ENDPOINTS,
} from './oauth/index.js';
export type {
  CodexOAuthState,
  CodexOAuthEndpoints,
  CodexOAuthResult,
  DeviceAuthInitResult,
  DeviceAuthPollResult,
  PollUntilCompleteOptions,
  BrowserAuthOptions,
} from './oauth/index.js';
