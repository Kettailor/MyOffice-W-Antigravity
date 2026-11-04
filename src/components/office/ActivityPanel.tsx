// The right column: today's numbers, the timeline button, filters and the activity feed.
// Static markup: the office's code (src/office) finds these elements by id and fills them in.
import { getT } from '@/i18n/server';

export default async function ActivityPanel() {
  const t = await getT();
  return (
    <>
      <aside className="side side-right" id="feed" aria-label={t('ui.activityPanel.title')}>
        <div className="act-head-bar">
          <button className="act-head" id="feed-toggle" type="button" aria-expanded="false">
            <span className="act-title">{t('ui.activityPanel.title')}</span>
            <span className="live-tag" id="live-tag"><i></i><span>{t('ui.activityPanel.live')}</span></span>
          </button>
          <button
            type="button"
            id="feed-collapse-btn"
            className="rail-toggle feed-collapse-btn"
            title={t('ui.activityPanel.collapse')}
            aria-label={t('ui.activityPanel.collapse')}
            aria-expanded="true"
          >
            <span data-icon="chevron"></span>
          </button>
        </div>
        <div className="kpis" id="feed-stats" aria-label={t('ui.activityPanel.today')}></div>
        <button type="button" className="tl-open" id="tl-open"><span data-icon="timeline"></span><b>{t('ui.activityPanel.timeline')}</b><span className="tl-open-v" id="tl-open-v">{t('ui.activityPanel.timelineSub')}</span></button>
        <button type="button" className="tl-open" id="wrap-open"><span data-icon="trophy"></span><b>{t('ui.activityPanel.wrapped')}</b><span className="tl-open-v">{t('ui.activityPanel.wrappedSub')}</span></button>
        <div className="seg" role="group" aria-label={t('ui.activityPanel.filter')}>
          <button type="button" id="flt-all" aria-pressed="true"><span data-icon="list"></span><span>{t('ui.activityPanel.all')}</span></button>
          <button type="button" id="flt-att" aria-pressed="false"><i className="red-dot"></i><span>{t('ui.activityPanel.attention')}</span><b id="att-count" hidden></b></button>
        </div>
        <div className="feed-search-wrap">
          <label className="search feed-search">
            <span data-icon="search"></span>
            <input
              id="feed-search"
              type="search"
              placeholder={t('ui.activityPanel.searchPlaceholder')}
              autoComplete="off"
              aria-label={t('ui.activityPanel.searchPlaceholder')}
            />
          </label>
        </div>
        <div className="type-chips" id="type-chips" role="group" aria-label={t('ui.activityPanel.types')}>
          <button type="button" data-k="cmd" aria-pressed="false"><span data-icon="terminal"></span>{t('ui.activityPanel.cmd')}</button>
          <button type="button" data-k="edit" aria-pressed="false"><span data-icon="pencil"></span>{t('ui.activityPanel.edit')}</button>
          <button type="button" data-k="read" aria-pressed="false"><span data-icon="file"></span>{t('ui.activityPanel.read')}</button>
          <button type="button" data-k="web" aria-pressed="false"><span data-icon="globe"></span>{t('ui.activityPanel.web')}</button>
          <button type="button" data-k="agent" aria-pressed="false" hidden><span data-icon="users"></span>{t('ui.activityPanel.agent')}</button>
        </div>
        <ul className="feed-list" id="feed-list"><li className="fi-empty">{t('ui.activityPanel.empty')}</li></ul>
      </aside>
      <button
        type="button"
        id="feed-expand-fab"
        className="feed-expand-fab"
        title={t('ui.activityPanel.expand')}
        aria-label={t('ui.activityPanel.expand')}
      >
        <span className="feed-fab-arr" data-icon="back"></span>
        <span data-icon="list"></span>
        <span className="feed-fab-lbl">{t('ui.activityPanel.fabLabel')}</span>
        <b className="feed-fab-count" id="feed-fab-count">0</b>
      </button>
    </>
  );
}
