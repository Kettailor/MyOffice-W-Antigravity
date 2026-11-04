// The left column: session counts, search and the session list.
// Static markup: the office's code (src/office) finds these elements by id and fills them in.
import { getT } from '@/i18n/server';

export default async function SessionRail() {
  const t = await getT();
  return (
    <>
      <aside className="side side-left" aria-label={t('ui.sessionRail.title')}>
        <div className="lp-head">
          <div className="lp-title rail-top">
            <h2>{t('ui.sessionRail.title')}</h2>
            <div className="rail-top-actions">
              <p className="conn" id="conn" data-state="off"><i></i><span>{t('ui.sessionRail.connecting')}</span></p>
              <button
                type="button"
                id="rail-toggle"
                className="rail-toggle"
                title={t('ui.sessionRail.collapse')}
                aria-label={t('ui.sessionRail.collapse')}
                aria-expanded="true"
              >
                <span data-icon="back"></span>
              </button>
            </div>
          </div>
          <p className="lp-sub" id="active-count">{t('ui.sessionRail.loading')}</p>
          <div className="st-row" role="group" aria-label={t('ui.sessionRail.statusFilter')}>
            <button type="button" className="st" data-st="work" aria-pressed="false"><i></i><b id="st-work">0</b><span>{t('ui.sessionRail.work')}</span></button>
            <button type="button" className="st" data-st="wait" aria-pressed="false"><i></i><b id="st-wait">0</b><span>{t('ui.sessionRail.wait')}</span></button>
            <button type="button" className="st" data-st="rest" aria-pressed="false"><i></i><b id="st-rest">0</b><span>{t('ui.sessionRail.rest')}</span></button>
            <button type="button" className="st" data-st="home" aria-pressed="false"><i></i><b id="st-home">0</b><span>{t('ui.sessionRail.home')}</span></button>
          </div>
          <div className="rail-search-row">
            <label className="search"><span data-icon="search"></span><input id="sess-search" type="search" placeholder={t('ui.sessionRail.search')} autoComplete="off" aria-label={t('ui.sessionRail.searchLabel')} /></label>
          </div>
          <div className="rail-toolbar" role="toolbar" aria-label={t('ui.sessionRail.viewMode')}>
            <div className="rail-view-seg" role="group" aria-label={t('ui.sessionRail.viewMode')}>
              <button
                type="button"
                className="rail-view-btn"
                data-rail-group="folder"
                aria-pressed="true"
                title={t('ui.sessionRail.byFolderTitle')}
              >
                <span data-icon="folder"></span>
                <span>{t('ui.sessionRail.byFolder')}</span>
              </button>
              <button
                type="button"
                className="rail-view-btn"
                data-rail-group="status"
                aria-pressed="false"
                title={t('ui.sessionRail.byStatusTitle')}
              >
                <span data-icon="list"></span>
                <span>{t('ui.sessionRail.byStatus')}</span>
              </button>
            </div>
            <div className="rail-toolbar-acts">
              <button
                type="button"
                id="rail-fold-all"
                className="rail-icon-btn"
                title={t('ui.sessionRail.foldAll')}
                aria-label={t('ui.sessionRail.foldAll')}
              >
                <span data-icon="chevron"></span>
              </button>
              <div className="rail-cfg-wrap">
                <button
                  type="button"
                  id="rail-cfg-btn"
                  className="rail-icon-btn"
                  title={t('ui.sessionRail.cfgBtn')}
                  aria-label={t('ui.sessionRail.cfgBtn')}
                  aria-expanded="false"
                >
                  <span data-icon="sliders"></span>
                </button>
                <div className="rail-cfg-pop" id="rail-cfg-pop" hidden role="dialog" aria-label={t('ui.sessionRail.cfgTitle')}>
                  <div className="rail-cfg-head">{t('ui.sessionRail.cfgTitle')}</div>
                  <button type="button" className="tgl rail-cfg-tgl" data-rail-cfg="groupByFolder" role="switch" aria-checked="true">
                    <span>{t('ui.sessionRail.cfgGroupFolder')}</span><i></i>
                  </button>
                  <button type="button" className="tgl rail-cfg-tgl" data-rail-cfg="showPath" role="switch" aria-checked="true">
                    <span>{t('ui.sessionRail.cfgShowPath')}</span><i></i>
                  </button>
                  <button type="button" className="tgl rail-cfg-tgl" data-rail-cfg="showMetrics" role="switch" aria-checked="true">
                    <span>{t('ui.sessionRail.cfgShowMetrics')}</span><i></i>
                  </button>
                  <button type="button" className="tgl rail-cfg-tgl" data-rail-cfg="expandIdle" role="switch" aria-checked="true">
                    <span>{t('ui.sessionRail.cfgExpandIdle')}</span><i></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <ul className="sess-list" id="rail-list"></ul>
      </aside>
      <button
        type="button"
        id="rail-expand-fab"
        className="rail-expand-fab"
        title={t('ui.sessionRail.expand')}
        aria-label={t('ui.sessionRail.expand')}
      >
        <span data-icon="users"></span>
        <span className="rail-fab-lbl">{t('ui.sessionRail.fabLabel')}</span>
        <b className="rail-fab-count" id="rail-fab-count">0</b>
        <span className="rail-fab-arr" data-icon="chevron"></span>
      </button>
    </>
  );
}
