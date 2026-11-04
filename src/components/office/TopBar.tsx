// The top bar: brand and clock, plan and Mac pills, replay, settings, night switch.
// Static markup: the office's code (src/office) finds these elements by id and fills them in.
import SettingsPanel from './SettingsPanel';
import { getT } from '@/i18n/server';

export default async function TopBar() {
  const t = await getT();
  return (
    <>
      <header className="topbar">
        <div className="tb-brand">
          <span className="logo" data-icon="logo"></span>
          <span className="tb-brand-name">My Office</span>
          <span className="tb-clock" id="clock">--:--</span>
          <span className="demo-chip" id="demo-chip" hidden>DEMO<span className="demo-more"> · {t('ui.topBar.sampleData')}</span></span>
          <span className="demo-chip replay-chip" id="replay-chip" hidden></span>
        </div>

        <div className="tb-center">
          <button
            id="btn-cmd-palette"
            className="tb-cmd-pill"
            type="button"
            title={t('ui.topBar.cmdTitle')}
            aria-label={t('ui.topBar.cmdTitle')}
            aria-haspopup="dialog"
            aria-controls="cmd-palette-modal"
          >
            <span data-icon="search"></span>
            <span className="tb-cmd-txt">{t('ui.topBar.cmdSearch')}</span>
            <kbd className="tb-kbd">Ctrl K</kbd>
          </button>

          <div className="tb-ws-modes" id="workspace-mode-seg" role="group" aria-label="Workspace layout mode">
            <button
              type="button"
              className="tb-ws-btn"
              data-ws-mode="balanced"
              aria-pressed="true"
              title={t('ui.topBar.modeBalancedTitle')}
            >
              <span data-icon="sliders"></span>
              <span className="tb-ws-lbl">{t('ui.topBar.modeBalanced')}</span>
            </button>
            <button
              type="button"
              className="tb-ws-btn"
              data-ws-mode="cinema"
              aria-pressed="false"
              title={t('ui.topBar.modeCinemaTitle')}
            >
              <span data-icon="maximize"></span>
              <span className="tb-ws-lbl">{t('ui.topBar.modeCinema')}</span>
            </button>
            <button
              type="button"
              className="tb-ws-btn"
              data-ws-mode="focus"
              aria-pressed="false"
              title={t('ui.topBar.modeFocusTitle')}
            >
              <span data-icon="terminal"></span>
              <span className="tb-ws-lbl">{t('ui.topBar.modeFocus')}</span>
            </button>
          </div>
        </div>

        <div className="tb-actions">
          <div className="pop-wrap">
            <button id="btn-plan" className="tb-btn mac-pill plan-pill" type="button" data-level="normal" aria-expanded="false" aria-controls="pop-plan" hidden><i className="lvl"></i><span className="mp-label">{t('ui.topBar.plan')}</span><span className="mp-val" id="plan-mini">{t('ui.topBar.reading')}</span><span className="mp-bar"><b id="plan-bar"></b></span></button>
            <div className="pop pop-plan" id="pop-plan" hidden role="dialog" aria-label={t('ui.topBar.planLimits')}>
              <div className="plan-card" id="plan-card">
                <span className="hl-head"><b>{t('ui.topBar.planLimits')}</b><span className="pl-at" id="plan-at"></span></span>
                <span className="plan-acct" id="plan-acct" hidden></span>
                <div className="plan-rows" id="plan-rows"></div>
                <div className="plan-add" id="plan-add"></div>
                <p className="plan-empty" id="plan-empty">{t('ui.topBar.planEmpty')}</p>
                <p className="plan-foot">{t('ui.topBar.planFoot')}</p>
              </div>
            </div>
          </div>
          <button id="btn-mac" className="tb-btn mac-pill" type="button" data-level="normal" title={t('ui.topBar.macTitle')}><i className="lvl"></i><span className="mp-label">{t('ui.topBar.mac')}</span><span className="mp-val" id="mac-mini">{t('ui.topBar.measuring')}</span><span className="mp-bar"><b id="ml-ram"></b></span><i className="mp-tip" id="mac-tip" hidden></i></button>
          <div className="tb-group tb-group--primary">
            <a id="btn-antigravity-ide" href="/antigravity" className="tb-btn tb-agy-ide" title={t('ui.topBar.antigravityIdeTitle')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 3.2C8.8 3.2 6.2 8.4 3.6 19.2C3.3 20.3 4.5 21 5.4 20.2C7.4 18.4 9.5 16.8 12 16.8C14.5 16.8 16.6 18.4 18.6 20.2C19.5 21 20.7 20.3 20.4 19.2C17.8 8.4 15.2 3.2 12 3.2ZM12 7.6C13.3 7.6 14.7 10.3 15.8 14.3C14.6 13.7 13.3 13.4 12 13.4C10.7 13.4 9.4 13.7 8.2 14.3C9.3 10.3 10.7 7.6 12 7.6Z" fill="currentColor" />
              </svg>
              <span className="lbl">{t('ui.topBar.antigravityIde')}</span>
            </a>
            <button id="btn-task" className="tb-btn tb-task" type="button" title={t('ui.topBar.taskTitle')}><span data-icon="clipboard"></span><span className="lbl">{t('ui.topBar.task')}</span></button>
            <button id="btn-mcp" className="tb-btn tb-mcp" type="button" aria-expanded="false" aria-controls="mcp-modal" title={t('ui.topBar.mcpTitle')}><span data-icon="plug"></span><span className="lbl">{t('ui.topBar.mcp')}</span><i className="tb-badge mcp-top-badge" id="mcp-badge" hidden></i></button>
            <button id="btn-chat" className="tb-btn tb-chat" type="button" aria-pressed="false" title={t('chat.openTitle')}><span data-icon="chat"></span><span className="lbl">{t('chat.open')}</span><i className="tb-badge" id="chat-badge" hidden></i></button>
          </div>
          <div className="tb-group tb-group--sys">
            <button id="btn-replay" className="tb-btn tb-icon" type="button" aria-pressed="false" aria-label={t('ui.topBar.replay')} title={t('ui.topBar.replayTitle')}><span data-icon="rewind"></span><span className="lbl" hidden>{t('ui.topBar.replay')}</span></button>
            <div className="pop-wrap">
              <button id="btn-look" className="tb-btn tb-icon" type="button" aria-expanded="false" aria-controls="pop-look" aria-label={t('ui.topBar.settings')} title={t('ui.topBar.settingsTitle')}><span data-icon="gear"></span><span className="lbl" hidden>{t('ui.topBar.settings')}</span></button>
              <SettingsPanel />
            </div>
            <button id="btn-phone-top" className="tb-btn tb-icon" type="button" hidden aria-label={t('ui.topBar.phone')} title={t('ui.topBar.phoneTitle')}><span data-icon="phone"></span></button>
            <button id="btn-night" className="tb-btn tb-icon" type="button" aria-pressed="false" aria-label={t('ui.topBar.nightLabel')} title={t('ui.topBar.nightTitle')}><span data-icon="moon"></span></button>
          </div>
        </div>
      </header>

      <div className="cmd-modal-backdrop" id="cmd-palette-modal" hidden role="dialog" aria-modal="true" aria-label={t('ui.topBar.cmdTitle')}>
        <div className="cmd-modal-card">
          <div className="cmd-input-row">
            <span className="cmd-search-ic" data-icon="search"></span>
            <input
              id="cmd-palette-input"
              className="cmd-input"
              type="search"
              placeholder={t('ui.cmdPalette.placeholder')}
              autoComplete="off"
              aria-label={t('ui.cmdPalette.placeholder')}
            />
            <kbd className="cmd-esc-badge" id="cmd-palette-close">ESC</kbd>
          </div>
          <div className="cmd-results" id="cmd-palette-list" role="listbox"></div>
          <footer className="cmd-footer">
            <span>{t('ui.cmdPalette.hint')}</span>
            <span className="cmd-footer-brand">OmniGlass 21st.dev HUD</span>
          </footer>
        </div>
      </div>
    </>
  );
}
