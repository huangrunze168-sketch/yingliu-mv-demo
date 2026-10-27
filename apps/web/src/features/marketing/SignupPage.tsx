import { useState, type FormEvent } from 'react';
import { navigate } from '../../app/router';
import { isDemoAdminCredentials, readSignupRedirect, startSession } from '../auth/session';
import '../../marketing.css';

const benefits = [
  ['少量生成额度', '注册后立即获得，先完整走一遍创作闭环。'],
  ['最长 15 秒低清预览', '先确认节奏与分镜，再决定是否继续。'],
  ['一次局部重做体验', '锁定满意镜头，只修改不满意的一镜。'],
];

export function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.includes('@')) {
      setError('请输入有效的邮箱地址。');
      return;
    }
    if (password.length < 8) {
      setError('密码至少需要 8 位字符。');
      return;
    }
    if (!agreed) {
      setError('请先确认你拥有上传素材的使用权。');
      return;
    }
    const normalizedEmail = email.trim();
    startSession(normalizedEmail, isDemoAdminCredentials(normalizedEmail, password) ? 'admin' : 'user');
    navigate(readSignupRedirect());
  };

  return (
    <div className="marketing-page signup-page">
      <header className="marketing-nav">
        <a className="marketing-brand" href="/" aria-label="小QTV 首页">
          <span className="brand-symbol">Q</span>
          <span>小QTV</span>
        </a>
        <nav className="marketing-links" aria-label="注册页导航">
          <a href="/#method">方法</a>
          <a href="/#workflow">流程</a>
        </nav>
        <a className="nav-cta" href="/">返回首页 <span>↖</span></a>
      </header>

      <main className="signup-shell section-shell">
        <section className="signup-story">
          <p className="overline">START WITH A REFERENCE</p>
          <h1>先免费做一支，<em>再决定要不要继续。</em></h1>
          <p className="signup-lede">小QTV 提取镜头语言与制作方法，不复制参考作品的具体内容。注册后即可进入四步创作流程。</p>
          <ul className="signup-benefits">
            {benefits.map(([title, copy]) => (
              <li key={title}>
                <div>
                  <b>{title}</b>
                  <small>{copy}</small>
                </div>
              </li>
            ))}
          </ul>
          <p className="signup-note">免费体验带小QTV水印；涉及付费生成或覆盖已有结果时，系统会先停下来征求确认。</p>
        </section>

        <section className="signup-card" aria-labelledby="signup-title">
          <p className="overline">FREE START · NO CREDIT CARD</p>
          <h2 id="signup-title">创建你的小QTV账号</h2>
          <p className="signup-card-lede">用一个邮箱开始，稍后可以随时补充资料。支持本地演示管理员登录。</p>
          <form className="signup-form" onSubmit={submit} noValidate>
            <label>
              <span>邮箱</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <label>
              <span>密码</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="至少 8 位字符"
              />
            </label>
            <label className="signup-check">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>我确认拥有上传素材的使用权，并同意《使用说明》。</span>
            </label>
            {error && <p className="signup-error" role="alert">{error}</p>}
            <button className="button button-primary signup-submit" type="submit">
              免费开始创作 <span>↗</span>
            </button>
          </form>
          <p className="signup-switch">已有想法，先看看流程？ <a href="/create">直接进入四步创作 →</a></p>
        </section>
      </main>

      <footer className="marketing-footer">
        <div className="section-shell footer-inner">
          <span>小QTV · 懂镜头语言的创作搭档</span>
          <a href="/">了解更多 ↗</a>
        </div>
      </footer>
    </div>
  );
}

