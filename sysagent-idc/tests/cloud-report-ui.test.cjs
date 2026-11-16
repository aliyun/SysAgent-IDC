const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};
require.extensions['.tsx'] = require.extensions['.ts'];
global.window = { setTimeout, location: { protocol: 'http:' }, requestAnimationFrame: callback => callback() };
global.document = { querySelector: () => null };

const { CloudReportModal, cloudActive, cloudStatusLabels, itemNameLabels, levelLabels, levelRank } = require('../src/CloudReport.tsx');

const levels = ['Critical', 'Error', 'Warning', 'Suggestion', 'Normal'];
function report(overrides = {}) {
  return {
    reportVersion: '1.0', reportId: 'report-1', status: 'success',
    name: '云端巡检报告', createdAt: '2026-11-01T12:34:56.000Z', updatedAt: '2026-11-01T12:35:56.000Z',
    scope: { hostname: 'fixture-host', window: '5m', profile: 'inspection' },
    summary: { overallLevel: 'Warning', totalItems: 10, abnormalItems: 2, totalInstances: 3, abnormalInstances: 1 },
    itemSummaries: [
      { itemName: 'disk.capacity', level: 'Error', reason: '根文件系统使用率 93%' },
      { itemName: 'memory.pressure', level: 'Normal' },
    ],
    ...overrides,
  };
}
const render = (value) => renderToStaticMarkup(React.createElement(CloudReportModal, { report: value, onClose: () => {} }));

test('cloud status labels and the active set separate in-flight uploads from terminal outcomes', () => {
  assert.deepEqual([...cloudActive].sort(), ['analyzing', 'created', 'downloading', 'queued', 'reporting', 'uploaded', 'validating']);
  for (const status of cloudActive) assert.equal(typeof cloudStatusLabels[status], 'string');
  for (const status of ['completed', 'partial_completed', 'failed', 'expired', 'cancelled']) {
    assert.equal(cloudActive.has(status), false, `${status} must not keep the UI in a collecting state`);
    assert.equal(typeof cloudStatusLabels[status], 'string');
  }
  assert.equal(Object.values(cloudStatusLabels).every(label => label.length > 0 && !/^[a-z_]+$/.test(label)), true);
});

test('report levels are ranked worst-first and every level has a Chinese label', () => {
  assert.deepEqual(levels.map(level => levelRank[level]), [0, 1, 2, 3, 4]);
  assert.deepEqual(levels.map(level => levelLabels[level]), ['严重', '错误', '警告', '建议', '正常']);
  for (const [name, label] of Object.entries(itemNameLabels)) {
    assert.match(name, /^[a-z]+\.[a-z_]+$/);
    assert.ok(label.length > 0 && label !== name);
  }
  assert.equal(itemNameLabels['disk.capacity'], '磁盘容量');
});

test('a full cloud report renders the overall level, counts, scope and item findings', () => {
  const html = render(report());
  assert.match(html, /sh-level-badge warning">警告</);
  assert.match(html, /巡检项 10 · 异常 2/);
  assert.match(html, /实例 3 · 异常 1/);
  assert.match(html, /主机 fixture-host · 窗口 5m · inspection/);
  assert.match(html, /报告 report-1/);
  assert.match(html, /云端巡检报告/);
  assert.match(html, /report-item warning/);
  assert.match(html, /磁盘容量 · 错误/);
  assert.match(html, /根文件系统使用率 93%/);
  assert.match(html, /内存压力 · 正常/);
  assert.match(html, /未见异常说明/);
  assert.equal((html.match(/report-item warning/g) || []).length, 1);
  assert.equal((html.match(/class="report-item /g) || []).length, 2);
  assert.doesNotMatch(html, /本次报告未包含项级结果/);
});

test('the warning boundary follows levelRank, so suggestions are not presented as anomalies', () => {
  for (const level of levels) {
    const html = render(report({ summary: { overallLevel: level }, itemSummaries: [{ itemName: 'cpu.saturation', level, reason: 'x' }] }));
    const warning = levelRank[level] <= levelRank.Warning;
    assert.equal(html.includes('report-item warning'), warning, `${level} warning flag`);
    assert.match(html, new RegExp(`sh-level-badge ${level.toLowerCase()}">${levelLabels[level]}<`));
    assert.match(html, /CPU 饱和度 · /);
  }
});

test('unknown levels and item names pass through instead of being silently dropped', () => {
  const html = render(report({ summary: { overallLevel: 'Unheard' }, itemSummaries: [{ itemName: 'custom.check', level: 'Unheard', reason: '自定义说明' }] }));
  assert.match(html, /sh-level-badge unheard">Unheard</);
  assert.match(html, /custom\.check · Unheard/);
  assert.match(html, /自定义说明/);
  // levelRank 未知等级回退到 4（与 Normal 同级），因此不会被标成告警项。
  assert.equal(levelRank.Unheard, undefined);
  assert.equal(html.includes('report-item warning'), false);
});

test('a sparse report falls back to item counts and omits absent scope without inventing data', () => {
  const html = render(report({ name: undefined, scope: undefined, summary: undefined, itemSummaries: [{ itemName: 'fd.exhaustion', level: 'Critical' }] }));
  assert.match(html, /巡检项 1 · 异常 0/);
  assert.match(html, /实例 0 · 异常 0/);
  assert.match(html, /sh-level-badge normal">正常</);
  assert.match(html, /文件描述符 · 严重/);
  assert.doesNotMatch(html, /sh-cloud-report-scope/);
  assert.doesNotMatch(html, /主机 /);
  assert.match(html, /云端巡检报告/);
});

test('an empty item list states that the report carries no item results', () => {
  const html = render(report({ itemSummaries: [] }));
  assert.match(html, /本次报告未包含项级结果。/);
  assert.match(html, /巡检项 10 · 异常 2/);
  assert.doesNotMatch(html, /report-item/);
  const absent = render(report({ itemSummaries: undefined, summary: undefined }));
  assert.match(absent, /本次报告未包含项级结果。/);
  assert.match(absent, /巡检项 0 · 异常 0/);
});

test('the modal keeps the report identity and a close control for the caller', () => {
  const html = render(report({ name: '', reportId: 'report-xyz' }));
  assert.match(html, /<dialog class="modal wide"/);
  assert.match(html, /aria-labelledby=/);
  assert.match(html, /报告 report-xyz/);
  assert.match(html, /<h2 id="[^"]+">云端巡检报告<\/h2>/);
  assert.match(html, /aria-label="关闭弹窗"/);
  assert.match(html, /aria-label="云端巡检报告"/);
});