import { getT } from '@/i18n/server';

export default async function McpModal() {
  const t = await getT();
  return (
    <div className="modal mcp-modal-wrap" id="mcp-modal" hidden>
      <div className="modal-card mcp-modal-card" role="dialog" aria-modal="true" aria-labelledby="mcp-title">
        <header className="mcp-head">
          <div className="mcp-head-title">
            <span className="mcp-head-ic" data-icon="plug"></span>
            <div>
              <h2 id="mcp-title">{t('ui.mcp.title')}</h2>
              <p className="mcp-sub" id="mcp-subtitle">{t('ui.mcp.subtitle')}</p>
            </div>
          </div>
          <div className="mcp-head-acts">
            <button className="btn btn--sm" type="button" id="mcp-btn-test-all">{t('ui.mcp.testAll')}</button>
            <button className="btn btn--sm mcp-btn-add" type="button" id="mcp-btn-add">{t('ui.mcp.addServer')}</button>
            <button className="icon-btn" type="button" id="mcp-close" data-close aria-label={t('common.close')}><span data-icon="x"></span></button>
          </div>
        </header>
        <div className="mcp-body" id="mcp-body"></div>
      </div>
    </div>
  );
}
