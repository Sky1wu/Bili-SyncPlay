import { DEFAULT_SERVER_URL } from "../background/runtime-state";
import { escapeHtml } from "./helpers";
import { t } from "../shared/i18n";

export function renderPopupTemplate(): string {
  return `
    <div class="card">
      <div class="hero">
        <div class="hero-copy">
          <h1 class="title">${escapeHtml(t("popupTitle"))}</h1>
        </div>
        <div class="hero-badge">LIVE</div>
      </div>

      <div class="grid">
        <div class="metric">
          <span class="metric-label">${escapeHtml(t("metricConnectionStatus"))}</span>
          <span class="metric-value" id="server-status">-</span>
        </div>
        <div class="metric">
          <span class="metric-label">${escapeHtml(t("metricRoomMembers"))}</span>
          <span class="metric-value" id="members-status">-</span>
        </div>
      </div>

      <div class="room-panel">
        <div class="metric room-code-metric" id="room-panel-joined">
          <div class="room-code-header">
            <div>
              <span class="metric-label">${escapeHtml(t("metricCurrentRoomCode"))}</span>
              <span class="metric-value room-code-value" id="room-status">-</span>
            </div>
            <div class="room-code-actions">
              <button class="secondary compact-button copy-button" id="copy-room" type="button">
                <span class="button-icon-wrap" aria-hidden="true">
                  <svg class="button-icon button-icon-copy" viewBox="0 0 16 16">
                    <rect x="5" y="3" width="8" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"></rect>
                    <path d="M3.5 10.5V5.5C3.5 4.4 4.4 3.5 5.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
                  </svg>
                  <svg class="button-icon button-icon-check" viewBox="0 0 16 16">
                    <path d="M3.2 8.3L6.6 11.4L12.8 4.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                  </svg>
                </span>
                <span class="button-label">${escapeHtml(t("actionCopy"))}</span>
              </button>
              <button class="secondary compact-button danger-button" id="leave-room" type="button">${escapeHtml(t("actionLeave"))}</button>
            </div>
          </div>
        </div>

        <div class="metric room-entry-metric" id="room-panel-idle">
          <div class="room-entry-header">
            <button class="compact-button" id="create-room" type="button">${escapeHtml(t("actionCreate"))}</button>
            <input id="room-code" placeholder="${escapeHtml(t("roomCodePlaceholder"))}">
            <button class="secondary compact-button" id="join-room" type="button">${escapeHtml(t("actionJoin"))}</button>
          </div>
        </div>
      </div>

      <div class="status-banner" id="status-message" hidden></div>

      <div class="section-title shared-video-heading">${escapeHtml(t("sectionSharedVideo"))}</div>

      <button class="video-card video-card-button" id="shared-video-card" type="button">
        <div class="video-title" id="shared-video-title">${escapeHtml(t("stateNoSharedVideo"))}</div>
        <div class="video-subline">
          <div class="video-meta" id="shared-video-meta">${escapeHtml(t("actionOpenSharedVideoHint"))}</div>
          <div class="video-owner" id="shared-video-owner" hidden>${escapeHtml(t("ownerSharedBy", { owner: "-" }))}</div>
        </div>
      </button>

      <button class="secondary compact-button full-width-button" id="share-current-video" type="button">${escapeHtml(t("actionShareCurrentVideo"))}</button>

      <div class="row">
        <div style="flex: 1;">
          <div class="section-title">${escapeHtml(t("sectionRoomMembers"))}</div>
          <div class="member-list" id="member-list"></div>
        </div>
      </div>
    </div>

    <div class="card">
      <details class="details">
        <summary>${escapeHtml(t("sectionAdvancedInfo"))}</summary>
        <div class="details-body">
          <div class="details-grid">
            <div class="metric" style="grid-column: span 2;">
              <span class="metric-label">${escapeHtml(t("metricServerUrl"))}</span>
              <div class="settings-row">
                <input id="server-url" placeholder="${escapeHtml(DEFAULT_SERVER_URL)}">
                <button class="secondary compact-button" id="save-server-url" type="button">${escapeHtml(t("actionSave"))}</button>
              </div>
            </div>
            <div class="metric">
              <span class="metric-label">${escapeHtml(t("metricCurrentIdentity"))}</span>
              <span class="metric-value" id="member-status">-</span>
            </div>
            <div class="metric">
              <span class="metric-label">${escapeHtml(t("metricReconnectCountdown"))}</span>
              <span class="metric-value retry-status" id="retry-status">
                <span id="retry-status-value">-</span>
                <span class="retry-status-count" id="retry-status-count"></span>
              </span>
            </div>
            <div class="metric" style="grid-column: span 2;">
              <span class="metric-label">${escapeHtml(t("metricClockSync"))}</span>
              <span class="metric-value" id="clock-status">-</span>
            </div>
          </div>
          <div class="logs-header">
            <div class="section-title">${escapeHtml(t("sectionDebugLogs"))}</div>
            <button class="secondary compact-button copy-button" id="copy-logs" type="button">
              <span class="button-icon-wrap" aria-hidden="true">
                <svg class="button-icon button-icon-copy" viewBox="0 0 16 16">
                  <rect x="5" y="3" width="8" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"></rect>
                  <path d="M3.5 10.5V5.5C3.5 4.4 4.4 3.5 5.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
                </svg>
                <svg class="button-icon button-icon-check" viewBox="0 0 16 16">
                  <path d="M3.2 8.3L6.6 11.4L12.8 4.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                </svg>
              </span>
              <span class="button-label">${escapeHtml(t("actionCopy"))}</span>
            </button>
          </div>
          <div class="log-box" id="debug-logs">
            <div class="muted">${escapeHtml(t("stateNoLogs"))}</div>
          </div>
        </div>
      </details>
    </div>
  `;
}
