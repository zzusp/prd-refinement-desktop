import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const issues = await readFile(new URL('../src/ResultIssues.tsx', import.meta.url), 'utf8');
const violations = [];
if (/alert\s*\(|confirm\s*\(|prompt\s*\(/.test(app)) violations.push('禁止使用原生 alert/confirm/prompt');
if (!css.includes(':focus-visible')) violations.push('缺少键盘焦点样式');
if (!css.includes('prefers-reduced-motion')) violations.push('缺少 reduced-motion 策略');
if (!app.includes('aria-label')) violations.push('关键结构缺少 aria-label');
if (!css.includes('padding:0 26px')) violations.push('统一顶部布局的左右间距丢失');
if (app.includes('platform-macos') || css.includes('window-controls-safe-left')) violations.push('顶部布局不应按操作系统分叉');
if (!app.includes('网络代理') || !app.includes('proxyUrl')) violations.push('Runtime 代理配置入口缺失');
if (app.includes('依次验证当前配置的节点模型')) violations.push('Runtime 连接检测不应逐节点串行探测');
if (/selectedProposalIds|generateResolutionProposals|acceptedProposals|待处理事项|建议方案/.test(app + issues)) violations.push('清单页面不应包含业务待处理事项或建议流程');
if (!app.includes('<ResultIssues project={task.project} />')) violations.push('执行记录必须保留平台核查结果');
if (violations.length) { console.error(violations.join('\n')); process.exit(1); }
console.log('UI contract smoke check passed');
