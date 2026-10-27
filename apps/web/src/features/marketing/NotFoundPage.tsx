import '../../marketing.css';

/** 404 页：未知路径的落点，视觉延续落地页暗色语言。 */
export function NotFoundPage() {
  return (
    <div className="marketing-page notfound-page">
      <header className="marketing-nav">
        <a className="marketing-brand" href="/" aria-label="小QTV 首页"><span className="brand-symbol">Q</span><span>小QTV</span></a>
      </header>
      <main className="notfound-main">
        <p className="overline">404 · PAGE NOT FOUND</p>
        <h1>这条链接没有对应的页面。</h1>
        <p className="notfound-lede">链接可能已过期，或者地址少了一段。回到首页重新出发。</p>
        <div className="notfound-actions">
          <a className="pill-cta" href="/">回到首页 <span>↗</span></a>
          <a className="ghost-dark" href="/create">进入四步创作 <span>▶</span></a>
        </div>
      </main>
    </div>
  );
}
