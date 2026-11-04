import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, Command, FileJson, FlaskConical, GitBranch, Layers, LayoutDashboard, Menu, Plus, Search, ShieldCheck, SlidersHorizontal, Sparkles, Terminal, Upload, X } from 'lucide-react';
import type { Evidence, Registry } from '../../../src/research';
import { exportTable } from '../../../src/table';
import { demoRegistry, download, parseRegistry } from './registry';
import './styles.css';

type Page = 'overview' | 'experiments' | 'evidence' | 'assistant';
const pages = [
  { id: 'overview', label: '工作台概览', icon: LayoutDashboard },
  { id: 'experiments', label: '实验管理', icon: FlaskConical },
  { id: 'evidence', label: '证据与来源', icon: ShieldCheck },
  { id: 'assistant', label: '研究助手', icon: Sparkles },
] as const;

function App() {
  const [page, setPage] = useState<Page>('overview');
  const [registry, setRegistry] = useState<Registry>(demoRegistry);
  const [demo, setDemo] = useState(true);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<Evidence | null>(null);
  const [notice, setNotice] = useState('');
  const [format, setFormat] = useState('markdown');
  const [menu, setMenu] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    if (!detail) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetail(null);
      if (event.key === 'Tab') {
        const controls = document.querySelectorAll<HTMLElement>('[role="dialog"] button');
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; previous?.focus(); };
  }, [detail]);
  const verified = registry.evidence.filter(item => item.status === 'verified').length;
  const visible = registry.runs.filter(run => {
    const evidence = registry.evidence.filter(item => item.runId === run.runId);
    return `${run.runId} ${run.dataset} ${run.protocol}`.toLowerCase().includes(query.toLowerCase()) &&
      (status === 'all' || (status === 'verified' ? evidence.every(item => item.status === 'verified') : evidence.some(item => item.status === 'unverified')));
  });
  const toggle = (id: string) => setSelected(value => value.includes(id) ? value.filter(item => item !== id) : [...value, id]);
  const navigate = (next: Page) => { setPage(next); setMenu(false); setQuery(''); setStatus('all'); };
  const exportResults = () => {
    try {
      const subset = selected.length ? { ...registry, runs: registry.runs.filter(run => selected.includes(run.runId)), evidence: registry.evidence.filter(item => selected.includes(item.runId)) } : registry;
      const snapshot = { ...subset, evidence: subset.evidence.map(item => ({ ...item, reason: `${item.reason}；Web 导出仅引用快照，未重新核验来源文件` })) };
      const contents = exportTable(snapshot, format);
      const prefix = format === 'latex' ? '% ' : format === 'markdown' ? '> ' : '';
      const warning = 'Web 导出：状态来自导入快照，未重新核验来源文件。';
      // CSV 保持标准表头；其他格式附带快照范围说明。
      download(format === 'csv' ? contents : `${prefix}${warning}\n\n${contents}`, `axiom-comparison.${{ markdown: 'md', csv: 'csv', latex: 'tex' }[format]}`);
      setNotice('对比表已导出。请注意：Web 不重新核验来源，导入状态不代表真实性认证。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '导出失败'); }
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('文件不能超过 5 MB。');
      const next = parseRegistry(JSON.parse(await file.text()));
      setRegistry(next); setDemo(false); setSelected([]); setDetail(null); setQuery(''); setStatus('all');
      setNotice(`已导入 ${next.runs.length} 个实验。证据状态来自文件声明，浏览器未重新核验。`);
    } catch (error) { setNotice(error instanceof Error ? error.message : '导入失败'); }
    finally { setImporting(false); if (input.current) input.current.value = ''; }
  };
  const importButton = <button className="button primary" onClick={() => input.current?.click()} disabled={importing}><Plus size={16} />{importing ? '正在导入…' : '导入实验'}</button>;
  return <div className="app-shell">
    <input type="file" accept=".json,application/json" ref={input} hidden onChange={event => void importFile(event.target.files?.[0])} />
    {menu && <button className="nav-backdrop" aria-label="关闭导航" onClick={() => setMenu(false)} />}
    <aside className={`sidebar ${menu ? 'open' : ''}`}>
      <a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('overview'); }}><span className="brand-mark">Λ<span>·</span></span><span>AXIOM<small>RESEARCH HARNESS</small></span></a>
      <div className="workspace"><span className="workspace-icon"><Layers size={18} /></span><div>本地研究空间<small>Personal workspace</small></div><ChevronDown size={14} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav>{pages.map(item => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><item.icon size={18} />{item.label}{item.id === 'assistant' && <span className="soon">预览</span>}</button>)}</nav>
      <div className="nav-label resources">RESOURCES</div>
      <a className="resource-link" href="https://github.com/luming9494/AXIOM" target="_blank" rel="noreferrer"><BookOpen size={17} />项目与文档<ArrowRight size={13} /></a>
      <button className="resource-link" onClick={() => setNotice('CLI：npm run axiom -- import <manifest.json> <registry.json>；生成后可在此导入。')}><Terminal size={17} />CLI 使用指南</button>
      <div className="sidebar-bottom"><div className="local-note"><span className="live-dot" />本地优先，证据为本<p>实验数据仅在当前浏览器内存中处理，不上传至模型服务。</p></div><div className="profile"><div className="avatar">R</div><div>Researcher<small>本地工作空间</small></div><span className="version">v0.1</span></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-toggle" aria-label="打开导航" onClick={() => setMenu(true)}><Menu size={20} /></button><span>工作空间</span><ChevronRight size={13} /><strong>{pages.find(item => item.id === page)?.label}</strong></div><div className="topbar-right"><span className="demo-pill"><span className="live-dot" />{demo ? '合成数据演示' : '本地快照模式'}</span><button className="icon-button" aria-label="查看使用说明" onClick={() => setNotice('导入 CLI 生成的 Registry JSON。数据只保存在内存中，刷新后恢复合成示例；Web 不访问原始实验文件。')}><CircleHelp size={18} /></button><span className="tiny-avatar">R</span></div></header>
      <main>
        <section className="page-heading"><div><div className="eyebrow">YOUR RESEARCH, CONNECTED.</div><h1>{page === 'overview' ? '让每一次实验，都有据可循。' : page === 'experiments' ? '实验管理' : page === 'evidence' ? '从指标，追溯到来源。' : '研究助手'}</h1><p>{page === 'assistant' ? '用自然语言连接实验上下文，保留每个结论的证据边界。' : '汇集实验记录、比较结果差异，让研究结论建立在可追溯的证据之上。'}</p></div><div className="heading-actions"><button className="button" onClick={() => { setRegistry(demoRegistry()); setDemo(true); setSelected([]); setDetail(null); setQuery(''); setStatus('all'); setNotice('已恢复公开合成示例。'); }}><FlaskConical size={15} />加载示例</button>{importButton}</div></section>
        {notice && <div className="notice" role="status"><CircleHelp size={17} /><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}
        {page === 'assistant' ? <section className="assistant-panel panel"><span className="assistant-symbol"><Sparkles size={30} /></span><span className="section-kicker">RESEARCH COPILOT · 即将接入</span><h2>先有证据，再有答案。</h2><p>Web 模型接口尚未连接。现阶段可使用 CLI 对校验后的实验快照提问；API 密钥仅保留在服务端或本地环境，绝不放入前端。</p><div className="prompt-examples"><span>比较两组实验的配置差异</span><span>哪些指标还缺少来源证据？</span><span>当前结果能支持什么结论？</span></div><div className="code-block">npm run axiom -- ask examples/synthetic-experiment/manifest.json "比较实验差异"</div><button className="button" onClick={() => navigate('experiments')}><ArrowLeft size={16} />返回实验管理</button></section> : <>
          <section className="stats-grid"><Stat label="实验记录" value={registry.runs.length} caption="当前工作空间中的 Run" icon={<FlaskConical size={18} />} /><Stat label="指标来源" value={registry.evidence.length} caption="每项指标关联来源产物" icon={<GitBranch size={18} />} /><Stat label="快照声明已核验" value={verified} caption={demo ? '演示数据尚未核验' : '仅引用导入状态，未重新核验'} icon={<ShieldCheck size={18} />} /><Stat label="待核验指标" value={registry.evidence.length - verified} caption="保留不确定性，不虚构结果" icon={<Activity size={18} />} /></section>
          {page === 'overview' && <section className="overview-grid"><div className="workflow-card"><div className="section-kicker"><span className="live-dot" />EVIDENCE-FIRST RESEARCH</div><h2>从实验记录，到可信结论。</h2><p>把分散的结果放进同一个研究上下文。<br />保留来源、检查可比性，再生成你的对比表。</p><div className="workflow"><span><FileJson size={17} />导入记录</span><ChevronRight size={14} /><span><ShieldCheck size={17} />追溯证据</span><ChevronRight size={14} /><span><ArrowDownToLine size={17} />导出结果</span></div><div className="orbital" aria-hidden="true"><div /><div /><div /><span>Λ</span><i /><i /></div></div><div className="panel quickstart"><div className="card-heading"><h2>开始你的研究工作流</h2><span className="muted">01 — 03</span></div><button onClick={() => input.current?.click()}><span className="step-number">01</span><div><strong>导入实验记录</strong><small>从 CLI Registry JSON 开始</small></div><ArrowRight size={16} /></button><button onClick={() => navigate('evidence')}><span className="step-number">02</span><div><strong>查看指标与证据</strong><small>区分来源匹配与真实性认证</small></div><ArrowRight size={16} /></button><button onClick={() => navigate('experiments')}><span className="step-number">03</span><div><strong>对比并导出结果</strong><small>Markdown / CSV / LaTeX</small></div><ArrowRight size={16} /></button></div></section>}
          <section className="panel experiment-panel"><div className="table-heading"><div><h2>{page === 'evidence' ? '证据索引' : '实验记录'}<span className="count">{registry.runs.length}</span></h2><p>{page === 'evidence' ? '点击证据查看来源路径、哈希及校验说明。' : '所有结果均保留配置、代码版本与指标来源。'}</p></div><div className="export-actions"><select aria-label="导出格式" value={format} onChange={event => setFormat(event.target.value)}><option value="markdown">Markdown</option><option value="csv">CSV</option><option value="latex">LaTeX</option></select><button className="button" onClick={exportResults}><ArrowDownToLine size={15} />导出{selected.length ? ` (${selected.length})` : '对比表'}</button></div></div><div className="table-toolbar"><div className="tabs"><button className={status === 'all' ? 'selected' : ''} onClick={() => setStatus('all')}>全部实验 <span>{registry.runs.length}</span></button><button className={status === 'unverified' ? 'selected' : ''} onClick={() => setStatus('unverified')}>待核验</button><button className={status === 'verified' ? 'selected' : ''} onClick={() => setStatus('verified')}>快照已核验</button></div><label className="search"><Search size={16} /><input aria-label="搜索实验" placeholder="搜索实验、数据集、协议…" value={query} onChange={event => setQuery(event.target.value)} /><SlidersHorizontal size={14} /></label></div><div className="table-scroll"><table><thead><tr><th className="check-cell"><input type="checkbox" aria-label="选择全部可见实验" checked={visible.length > 0 && visible.every(run => selected.includes(run.runId))} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, ...visible.map(run => run.runId)])] : current.filter(id => !visible.some(run => run.runId === id)))} /></th><th>实验 / Run ID</th><th>数据集 / 协议</th><th>核心指标</th><th>证据状态</th><th>代码版本</th><th /></tr></thead><tbody>{visible.map(run => { const evidence = registry.evidence.filter(item => item.runId === run.runId); const first = evidence[0]!; const valid = evidence.every(item => item.status === 'verified'); return <tr key={run.runId}><td><input type="checkbox" aria-label={`选择 ${run.runId}`} checked={selected.includes(run.runId)} onChange={() => toggle(run.runId)} /></td><td><button className="run-link" onClick={() => setDetail(first)}><span className="run-icon"><FlaskConical size={17} /></span><span>{run.runId}<small>seed {run.seed} · {Object.entries(run.config).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ') || '默认配置'}</small></span></button></td><td><strong className="cell-title">{run.dataset}</strong><small>{run.protocol}</small></td><td><div className="metric-value">{first.value}<span>{first.name}</span></div>{evidence.length > 1 && <small>另有 {evidence.length - 1} 项指标</small>}</td><td><button className={`status-badge ${valid ? 'verified' : ''}`} onClick={() => setDetail(first)}>{valid ? <Check size={12} /> : <span className="status-dot" />}{valid ? '快照已核验' : '待核验'}</button></td><td><span className="revision"><GitBranch size={13} />{run.codeRevision}</span></td><td><button className="icon-button" aria-label={`查看 ${run.runId} 详情`} onClick={() => setDetail(first)}><ChevronRight size={17} /></button></td></tr>; })}</tbody></table>{!visible.length && <div className="empty-state"><Search size={25} /><h3>没有匹配的实验</h3><p>试试其他关键词或切换筛选条件。</p><button className="button" onClick={() => { setQuery(''); setStatus('all'); }}>清除筛选</button></div>}</div><div className="table-footer"><span>显示 {visible.length} / {registry.runs.length} 个实验{selected.length > 0 && ` · 已选择 ${selected.length} 个`}</span><span><span className="live-dot" />{demo ? '公开合成示例 · 非真实研究结果' : '本地导入 · 数据仅保存在内存中'}</span></div></section>
          {page === 'evidence' && <section className="panel evidence-list"><h2>全部指标来源</h2>{registry.evidence.map(item => <button key={JSON.stringify([item.runId, item.name])} onClick={() => setDetail(item)}><FileJson size={18} /><span><strong>{item.name} = {item.value}</strong><small>{item.runId} / {item.artifact}</small></span><span className={`status-badge ${item.status === 'verified' ? 'verified' : ''}`}>{item.status === 'verified' ? '快照已核验' : '待核验'}</span><ChevronRight size={16} /></button>)}</section>}
          <div className="bottom-note"><ShieldCheck size={16} /><span>数值匹配 ≠ 实验真实性认证。Web 仅展示快照；使用 CLI 可重新读取来源并核验。</span><button onClick={() => setNotice('CLI 在每次导出时重新核验原始文件；浏览器无法读取路径所指的本地文件，因此不会新增 verified 声明。')}>了解证据边界 <ArrowRight size={13} /></button></div>
        </>}
        <footer><span>AXIOM <span className="footer-divider">/</span> From hypothesis to verifiable evidence.</span><span><Command size={12} /> Built on Pi · Frontend Preview</span></footer>
      </main>
    </div>
    {detail && <div className="modal-backdrop" onClick={() => setDetail(null)}><section className="detail-modal panel" role="dialog" aria-modal="true" aria-label="指标证据详情" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setDetail(null); }}><div className="card-heading"><h2>指标与来源</h2><button autoFocus className="icon-button" aria-label="关闭详情" onClick={() => setDetail(null)}><X size={20} /></button></div><div className="detail-score">{detail.value}<span>{detail.name}</span></div><label className="field-label">实验记录</label><p className="mono">{detail.runId}</p><label className="field-label">来源文件</label><p className="code-block">{detail.artifact}</p><label className="field-label">SHA-256 · 导入文件声明</label><p className="code-block hash">{detail.sha256 ?? '尚无校验哈希'}</p><label className="field-label">校验说明</label><p className="detail-reason">{detail.reason}</p><div className="detail-warning">当前状态：{detail.status === 'verified' ? '快照声明已核验' : '待核验'}。浏览器未读取来源文件，也未重新计算哈希；该状态不代表实验真实性认证。</div><label className="field-label">实验配置</label><pre className="code-block">{JSON.stringify(registry.runs.find(run => run.runId === detail.runId)?.config, null, 2)}</pre><button className="button" onClick={() => download(JSON.stringify({ ...detail, webNotice: '浏览器未重新核验来源文件' }, null, 2), 'axiom-evidence.json', 'application/json')}><Upload size={15} />下载证据记录</button></section></div>}
  </div>;
}
function Stat({ label, value, caption, icon }: { label: string; value: number; caption: string; icon: React.ReactNode }) { return <div className="stat-card panel"><div className="stat-label">{label}<span>{icon}</span></div><div className="stat-value">{String(value).padStart(2, '0')}<span>项</span></div><p>{caption}</p></div>; }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
