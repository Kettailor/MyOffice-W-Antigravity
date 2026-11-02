// The timeline panel: one lane per session, what it did and when it waited for you.
// Static markup: the office's code (src/office) finds these elements by id and fills them in.
import { getT } from '@/i18n/server';

export default async function TimelinePanel() {
  const t = await getT();
  return (
    <section className="tl" id="tl" hidden role="dialog" aria-labelledby="tl-title">
      <header className="tl-head">
        <div className="tl-title"><h2 id="tl-title">{t('ui.timeline.title')}</h2><p>{t('ui.timeline.intro')}</p></div>
        <button type="button" className="btn btn--sm" id="tl-csv"><span data-icon="file"></span>{t('ui.timeline.csv')}</button>
        <button type="button" className="icon-btn" id="tl-close" aria-label={t('common.close')}><span data-icon="x"></span></button>
      </header>
      <div className="tl-kpis tl-stats" id="tl-kpis"><div className="tl-stats-grid" id="tl-stats"></div></div>
      <div className="tl-toolbar">
        <div className="seg tl-ranges" role="group" aria-label={t('ui.ranges.label')}>
          <button type="button" data-tl="1h" aria-pressed="false" title={t('ui.ranges.h1Title')}>{t('ui.ranges.h1')}</button>
          <button type="button" data-tl="3h" aria-pressed="true" title={t('ui.ranges.h3Title')}>{t('ui.ranges.h3')}</button>
          <button type="button" data-tl="6h" aria-pressed="false" title={t('ui.ranges.h6Title')}>{t('ui.ranges.h6')}</button>
          <button type="button" data-tl="today" aria-pressed="false">{t('ui.ranges.all')}</button>
          <button type="button" data-tl="yesterday" aria-pressed="false">{t('ui.ranges.yesterday')}</button>
        </div>
        <div className="tl-legend" id="tl-legend"></div>
      </div>
      <div className="tl-scroll" id="tl-scroll"></div>
      <div className="tl-tip" id="tl-tip" hidden></div>
    </section>
  );
}
