import type { Browser, Page } from "playwright";
import type { HarnessRuntime } from "../types";
import type { RegisteredHarnessScenarioName } from "./metadata";
import { runImageArtifactDropUpload, runImageArtifactPaths, runImageAttachments, runImagePasteAttachments, runArtifactPathFormats, runMissingRemoteImageArtifact, runRemoteImageArtifactPaths, runRemoteImageArtifactUpload, runRepeatedImageArtifactPaths } from "./artifacts";
import { runBackendRestart, runConnectionDisconnected, runControllerHandoffEdges, runReconnectController, runReconnectDraft } from "./lifecycle";
import { runMobileImageStreamStability, runMobileLayout, runMobileLongTranscriptControls } from "./mobile";
import { runInspectorPreview, runModelThinking, runNarrowToolStream, runQueuedFollowUp, runStreamingResponsiveness, runSubagentCard, runSubagentCardReconnect, runToolGrouping, runToolImageHeavyTranscript, runTranscriptScrollStability, runTranscriptTextSelection } from "./transcript";
import { runBashCommands, runConfiguredExtensionSmoke, runFileAutocomplete, runSlashCommands } from "./slash-commands";
import { runContextUsage, runEmptySessionLayout, runQuestionAnswer, runSessionMetadata, runSessionRouting, runSessionsPage, runTreeForkNavigation } from "./session";
import { runThemeGallery, runThemes } from "./visual";

export type ScenarioRunner = (page: Page, browser: Browser, runtime: HarnessRuntime) => Promise<Record<string, unknown>>;

export const scenarioRunners = {
  "empty-session-layout": (page) => runEmptySessionLayout(page),
  "mobile-layout": (page) => runMobileLayout(page),
  "session-routing": (page) => runSessionRouting(page),
  "sessions-page": (page) => runSessionsPage(page),
  "streaming-responsiveness": (page) => runStreamingResponsiveness(page),
  "queued-follow-up": (page) => runQueuedFollowUp(page),
  "transcript-scroll-stability": (page) => runTranscriptScrollStability(page),
  "transcript-text-selection": (page) => runTranscriptTextSelection(page),
  "session-metadata": (page) => runSessionMetadata(page),
  "inspector-preview": (page) => runInspectorPreview(page),
  "slash-commands": (page) => runSlashCommands(page),
  "configured-extension-smoke": (page) => runConfiguredExtensionSmoke(page),
  "bash-commands": (page) => runBashCommands(page),
  "question-answer": (page) => runQuestionAnswer(page),
  "tree-fork-navigation": (page) => runTreeForkNavigation(page),
  "reconnect-controller": (page) => runReconnectController(page),
  "controller-handoff-edges": (page, browser) => runControllerHandoffEdges(page, browser),
  "reconnect-draft": (page) => runReconnectDraft(page),
  "backend-restart": (page, _browser, runtime) => runBackendRestart(page, runtime),
  "connection-disconnected": (page, _browser, runtime) => runConnectionDisconnected(page, runtime),
  "narrow-tool-stream": (page) => runNarrowToolStream(page),
  "tool-grouping": (page) => runToolGrouping(page),
  "tool-image-heavy-transcript": (page) => runToolImageHeavyTranscript(page),
  "subagent-card": (page) => runSubagentCard(page),
  "subagent-card-reconnect": (page) => runSubagentCardReconnect(page),
  "mobile-long-transcript-controls": (page) => runMobileLongTranscriptControls(page),
  "mobile-image-stream-stability": (page) => runMobileImageStreamStability(page),
  "file-autocomplete": (page) => runFileAutocomplete(page),
  "image-attachments": (page) => runImageAttachments(page),
  "image-paste-attachments": (page) => runImagePasteAttachments(page),
  "image-artifact-drop-upload": (page) => runImageArtifactDropUpload(page),
  "image-artifact-paths": (page) => runImageArtifactPaths(page),
  "repeated-image-artifact-paths": (page) => runRepeatedImageArtifactPaths(page),
  "artifact-path-formats": (page) => runArtifactPathFormats(page),
  "remote-image-artifact-paths": (page) => runRemoteImageArtifactPaths(page),
  "remote-image-artifact-upload": (page) => runRemoteImageArtifactUpload(page),
  "missing-remote-image-artifact": (page) => runMissingRemoteImageArtifact(page),
  "model-thinking": (page) => runModelThinking(page),
  "context-usage": (page) => runContextUsage(page),
  "themes": (page) => runThemes(page),
  "theme-gallery": (page) => runThemeGallery(page),
} satisfies Record<RegisteredHarnessScenarioName, ScenarioRunner>;

export function isRegisteredScenarioName(name: string): name is RegisteredHarnessScenarioName {
  return Object.hasOwn(scenarioRunners, name);
}
