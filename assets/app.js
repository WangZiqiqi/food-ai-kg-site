const COLORS = {
  claim: '#f6c85f', food: '#72f4d1', strain: '#b48cff', outcome: '#8ab6ff', experimental_condition: '#94a3b8', default: '#9fb3c8'
};
const DIRECTION = { beneficial: '#51e09b', harmful: '#ff6b8b', neutral: '#cbd5e1', mixed: '#ffd166', unclear: '#9fb3c8', positive: '#51e09b', negative: '#ff6b8b', unknown: '#9fb3c8' };
const $ = sel => document.querySelector(sel);
const fmt = new Intl.NumberFormat();
let graph, allNodes, allLinks, byId, adjacency, simulation, svg, g, linkSel, nodeSel, labelSel, zoom, width, height;
let renderedNodes = [], renderedLinks = [];
let selectedId = null;
let centerId = null;
let labelsOn = true;
let activeTypes = new Set();
let activeDirections = new Set();
let query = '';

fetch('./data/graph-data.json').then(r => r.json()).then(init).catch(err => {
  document.body.innerHTML = `<pre style="padding:24px;color:white">Failed to load graph-data.json\n${err.stack}</pre>`;
});

function init(data) {
  graph = data;
  allNodes = data.nodes.map(d => ({...d}));
  allLinks = data.links.map((d, i) => ({...d, id: `${d.source}--${d.target}--${i}`}));
  byId = new Map(allNodes.map(n => [n.id, n]));
  adjacency = new Map(allNodes.map(n => [n.id, []]));
  allLinks.forEach(l => {
    l.sourceId = typeof l.source === 'string' ? l.source : l.source.id;
    l.targetId = typeof l.target === 'string' ? l.target : l.target.id;
    l.sourceNode = byId.get(l.sourceId);
    l.targetNode = byId.get(l.targetId);
    if (l.sourceNode && l.targetNode) {
      adjacency.get(l.sourceId).push(l);
      adjacency.get(l.targetId).push(l);
    }
  });
  activeTypes = new Set(Object.keys(data.meta.typeCounts));
  activeDirections = new Set(Object.keys(data.meta.directionCounts));
  renderStats(data.meta.stats, allNodes);
  renderFilters(data.meta);
  renderLegend();
  setupGraph();
  setupEvents();
  updateResults();
  renderEmpty();
  window.addEventListener('resize', resize);
}

function renderStats(stats, nodes = []) {
  const evidenceRecords = stats.evidenceItems ?? stats.evidenceRecords ?? nodes
    .filter(n => n.type === 'claim')
    .reduce((sum, n) => sum + (Number(n.evidenceCount) || 0), 0);
  const items = [
    ['Nodes', stats.nodes],
    ['Links', stats.links],
    ['Claims', stats.claims],
    ['Evidence Records', evidenceRecords],
    ['Corpus Records', stats.corpusPmids]
  ].filter(([, v]) => v !== undefined && v !== null);
  $('#stats').innerHTML = items.map(([k,v]) => `<div class="stat"><strong>${fmt.format(v)}</strong><span>${k}</span></div>`).join('');
}

function renderFilters(meta) {
  const order = Object.entries(meta.typeCounts).sort((a,b) => b[1]-a[1]);
  $('#typeFilters').innerHTML = order.map(([t,c]) => `<button class="active" data-type="${esc(t)}"><span style="color:${colorFor(t)}">●</span> ${labelType(t)} · ${c}</button>`).join('');
  $('#directionFilters').innerHTML = Object.entries(meta.directionCounts).sort((a,b)=>b[1]-a[1]).map(([d,c]) => `<button class="active" data-direction="${esc(d)}"><span style="color:${DIRECTION[d]||DIRECTION.unknown}">●</span> ${d} · ${c}</button>`).join('');
}
function renderLegend() {
  const entries = ['claim','food','strain','outcome','experimental_condition'];
  $('#legend').innerHTML = entries.map(t => `<span class="legend-item"><i class="swatch" style="background:${colorFor(t)};color:${colorFor(t)}"></i>${labelType(t)}</span>`).join('');
}
function setupEvents() {
  $('#searchInput').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); updateResults(); });
  $('#searchInput').addEventListener('focus', () => updateResults());
  $('#searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const candidate = searchEntities(query)[0];
      if (candidate) renderLocalGraph(candidate.id);
    } else if (e.key === 'Escape') {
      hideResults();
    }
  });
  $('#clearSearch').addEventListener('click', () => { $('#searchInput').value=''; query=''; hideResults(); });
  $('#depthSelect').addEventListener('change', () => centerId ? renderLocalGraph(centerId) : null);
  $('#maxNodesSelect').addEventListener('change', () => centerId ? renderLocalGraph(centerId) : null);
  $('#overviewBtn').addEventListener('click', renderOverview);
  $('#typeFilters').addEventListener('click', e => {
    const btn = e.target.closest('button[data-type]'); if (!btn) return;
    const t = btn.dataset.type; activeTypes.has(t) ? activeTypes.delete(t) : activeTypes.add(t);
    btn.classList.toggle('active', activeTypes.has(t));
    rerenderCurrent();
  });
  $('#directionFilters').addEventListener('click', e => {
    const btn = e.target.closest('button[data-direction]'); if (!btn) return;
    const d = btn.dataset.direction; activeDirections.has(d) ? activeDirections.delete(d) : activeDirections.add(d);
    btn.classList.toggle('active', activeDirections.has(d));
    rerenderCurrent();
  });
  $('#fitBtn').addEventListener('click', fitGraph);
  $('#resetBtn').addEventListener('click', resetView);
  $('#labelsBtn').addEventListener('click', e => { labelsOn = !labelsOn; e.currentTarget.setAttribute('aria-pressed', labelsOn); e.currentTarget.classList.toggle('active', labelsOn); updateLabels(); });
  document.querySelector('.quick-actions').addEventListener('click', e => { const btn=e.target.closest('button[data-focus]'); if (btn) renderLocalGraph(btn.dataset.focus); });
  document.addEventListener('click', e => { if (!e.target.closest('.search-box')) hideResults(); });
}

function setupGraph() {
  svg = d3.select('#graph');
  g = svg.append('g');
  g.append('defs').append('marker').attr('id','arrow').attr('viewBox','0 -5 10 10').attr('refX', 18).attr('refY', 0).attr('markerWidth', 5).attr('markerHeight', 5).attr('orient','auto').append('path').attr('d','M0,-5L10,0L0,5').attr('fill','rgba(169,200,230,.38)');
  g.append('g').attr('class','links');
  g.append('g').attr('class','nodes');
  g.append('g').attr('class','labels');
  linkSel = g.select('.links').selectAll('line');
  nodeSel = g.select('.nodes').selectAll('circle');
  labelSel = g.select('.labels').selectAll('text');
  zoom = d3.zoom().scaleExtent([0.12, 5]).on('zoom', event => g.attr('transform', event.transform));
  svg.call(zoom).on('click', () => { selectedId=null; renderEmptyDetail(); updateHighlight(); });
  resize();
}

function searchEntities(q) {
  const qLower = (q || '').toLowerCase();
  const entityTypes = new Set(['food', 'strain', 'outcome', 'experimental_condition']);
  return allNodes
    .filter(n => entityTypes.has(n.type) && activeTypes.has(n.type))
    .filter(n => !qLower || n.searchText.includes(qLower))
    .sort((a,b) => {
      const ae = exactness(a, qLower), be = exactness(b, qLower);
      return (be-ae) || (b.degree-a.degree) || a.label.localeCompare(b.label);
    })
    .slice(0, 50);
}
function exactness(n, q) {
  if (!q) return 0;
  const label = n.label.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 50;
  if (label.includes(q)) return 20;
  return 0;
}
function updateResults() {
  const box = $('#resultList');
  if (!query) {
    hideResults();
    return;
  }
  const results = searchEntities(query).slice(0, 12);
  box.hidden = results.length === 0;
  box.innerHTML = results.length
    ? results.map(n => `<div class="result-item" data-id="${esc(n.id)}"><b>${esc(trim(n.label,72))}</b><span><i style="color:${colorFor(n.type)}">●</i>${labelType(n.type)} · degree ${n.degree}</span></div>`).join('')
    : '';
  box.querySelectorAll('.result-item').forEach(el => el.addEventListener('click', () => {
    const node = byId.get(el.dataset.id);
    if (node) $('#searchInput').value = node.label;
    query = '';
    hideResults();
    renderLocalGraph(el.dataset.id);
  }));
}
function hideResults() {
  const box = $('#resultList');
  if (!box) return;
  box.hidden = true;
  box.innerHTML = '';
}

function renderLocalGraph(id) {
  const center = byId.get(id) || allNodes.find(x => x.id.includes(id) || x.searchText.includes(String(id).replace(/^.*?_/, '').toLowerCase()));
  if (!center) return;
  centerId = center.id;
  selectedId = center.id;
  const depth = Number($('#depthSelect').value || 2);
  const maxNodes = Number($('#maxNodesSelect').value || 250);
  const subgraph = getEgoSubgraph(center.id, depth, maxNodes);
  renderSubgraph(subgraph.nodes, subgraph.links, `Center: ${center.label} · depth ${depth}`);
  renderDetail(center);
  hideResults();
}

function getEgoSubgraph(startId, maxDepth, maxNodes) {
  const distance = new Map([[startId, 0]]);
  const queue = [startId];
  const linkMap = new Map();
  while (queue.length) {
    const id = queue.shift();
    const d = distance.get(id);
    if (d >= maxDepth) continue;
    for (const edge of adjacency.get(id) || []) {
      const next = edge.sourceId === id ? edge.targetId : edge.sourceId;
      const nextNode = byId.get(next);
      if (!nextNode || !passesNodeFilters(nextNode, next === startId)) continue;
      linkMap.set(edge.id, edge);
      if (!distance.has(next)) {
        distance.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  let nodes = [...distance.keys()].map(id => byId.get(id)).filter(Boolean).filter(n => passesNodeFilters(n, n.id === startId));
  if (nodes.length > maxNodes) {
    nodes = nodes.sort((a,b) => {
      if (a.id === startId) return -1;
      if (b.id === startId) return 1;
      const da = distance.get(a.id) ?? 99, db = distance.get(b.id) ?? 99;
      return (da-db) || (scoreNode(b)-scoreNode(a)) || a.label.localeCompare(b.label);
    }).slice(0, maxNodes);
  }
  const keep = new Set(nodes.map(n => n.id));
  const links = [...linkMap.values()].filter(l => keep.has(l.sourceId) && keep.has(l.targetId));
  return { nodes, links };
}
function passesNodeFilters(n, force = false) {
  if (force) return true;
  if (!activeTypes.has(n.type)) return false;
  if (n.type === 'claim' && !activeDirections.has(n.direction || 'unknown')) return false;
  return true;
}
function scoreNode(n) {
  return (n.evidenceCount || 0) * 12 + (n.degree || 0) + (n.type === 'claim' ? 6 : 0);
}
function renderOverview() {
  centerId = null;
  selectedId = null;
  const maxNodes = Number($('#maxNodesSelect').value || 250);
  const nodes = allNodes.filter(n => passesNodeFilters(n)).sort((a,b) => scoreNode(b)-scoreNode(a)).slice(0, maxNodes);
  const keep = new Set(nodes.map(n => n.id));
  const links = allLinks.filter(l => keep.has(l.sourceId) && keep.has(l.targetId));
  renderSubgraph(nodes, links, `Overview · top ${nodes.length} nodes by evidence and degree`);
  renderEmptyDetail();
}
function renderSubgraph(nodes, links, label) {
  $('#graphEmpty').hidden = nodes.length > 0;
  renderedNodes = nodes.map(n => ({...n}));
  const localById = new Map(renderedNodes.map(n => [n.id, n]));
  renderedLinks = links.map(l => ({...l, source: localById.get(l.sourceId), target: localById.get(l.targetId)})).filter(l => l.source && l.target);
  updateRenderedStats(label, renderedNodes.length, renderedLinks.length);
  if (simulation) simulation.stop();
  linkSel = g.select('.links').selectAll('line').data(renderedLinks, d => d.id)
    .join(enter => enter.append('line').attr('class','link').attr('marker-end','url(#arrow)'));
  nodeSel = g.select('.nodes').selectAll('circle').data(renderedNodes, d => d.id)
    .join(enter => enter.append('circle')
      .attr('class','node')
      .attr('r', d => d.size)
      .attr('fill', d => colorFor(d.type))
      .on('mouseenter', showTooltip).on('mousemove', moveTooltip).on('mouseleave', hideTooltip)
      .on('click', (event,d) => { event.stopPropagation(); selectedId = d.id; renderDetail(byId.get(d.id) || d); updateHighlight(); })
      .call(d3.drag().on('start', dragstarted).on('drag', dragged).on('end', dragended))
    );
  labelSel = g.select('.labels').selectAll('text').data(renderedNodes, d => d.id)
    .join(enter => enter.append('text').attr('class','label').text(d => trim(d.label, 34)));
  simulation = d3.forceSimulation(renderedNodes)
    .force('link', d3.forceLink(renderedLinks).id(d => d.id).distance(d => d.type === 'subject_of' ? 88 : 72).strength(.58))
    .force('charge', d3.forceManyBody().strength(d => d.type === 'claim' ? -90 : -145))
    .force('collide', d3.forceCollide().radius(d => d.size + 7).iterations(2))
    .force('x', d3.forceX(width/2).strength(.05))
    .force('y', d3.forceY(height/2).strength(.05))
    .on('tick', ticked);
  updateHighlight();
  updateLabels();
  setTimeout(fitGraph, 650);
}
function updateRenderedStats(label, nodeCount, linkCount) {
  $('#renderedStats').innerHTML = `<b>${esc(label)}</b><br>${fmt.format(nodeCount)} rendered nodes · ${fmt.format(linkCount)} rendered links`;
}
function rerenderCurrent() {
  if (centerId) renderLocalGraph(centerId);
  else if (renderedNodes.length) renderOverview();
}

function resize() {
  const box = $('#graphWrap').getBoundingClientRect(); width = box.width; height = box.height;
  if (svg) svg.attr('viewBox', [0,0,width,height]);
  if (simulation) simulation.force('x', d3.forceX(width/2).strength(.05)).force('y', d3.forceY(height/2).strength(.05)).alpha(.2).restart();
}
function ticked() {
  linkSel.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
  nodeSel.attr('cx', d => d.x).attr('cy', d => d.y);
  labelSel.attr('x', d => d.x + d.size + 4).attr('y', d => d.y + 3);
}
function dragstarted(event,d){ if(simulation && !event.active) simulation.alphaTarget(.25).restart(); d.fx=d.x; d.fy=d.y; }
function dragged(event,d){ d.fx=event.x; d.fy=event.y; }
function dragended(event,d){ if(simulation && !event.active) simulation.alphaTarget(0); d.fx=null; d.fy=null; }

function updateHighlight() {
  const focus = selectedId ? neighborhood(selectedId) : null;
  nodeSel.classed('dim', d => focus ? !focus.nodes.has(d.id) : false).classed('highlight', d => d.id === selectedId || d.id === centerId);
  linkSel.classed('dim', d => focus ? !(focus.links.has(d.id)) : false).classed('highlight', d => focus ? focus.links.has(d.id) : false);
  labelSel.classed('dim', d => focus ? !focus.nodes.has(d.id) : false);
  updateLabels();
}
function updateLabels() {
  labelSel.style('display', d => (labelsOn || d.id === selectedId || d.id === centerId) ? null : 'none');
}
function neighborhood(id) {
  const ns = new Set([id]); const ls = new Set();
  renderedLinks.forEach(l => { if (l.source.id === id || l.target.id === id) { ns.add(l.source.id); ns.add(l.target.id); ls.add(l.id); } });
  return {nodes: ns, links: ls};
}
function fitGraph() {
  if (!renderedNodes.length) return;
  const xs = renderedNodes.map(n=>n.x).filter(Number.isFinite), ys = renderedNodes.map(n=>n.y).filter(Number.isFinite); if (!xs.length) return;
  const minX=d3.min(xs), maxX=d3.max(xs), minY=d3.min(ys), maxY=d3.max(ys);
  const dx=maxX-minX || width, dy=maxY-minY || height, scale=Math.max(.18, Math.min(1.85, .86/Math.max(dx/width, dy/height)));
  const tx=(width - scale*(minX+maxX))/2, ty=(height - scale*(minY+maxY))/2;
  svg.transition().duration(650).call(zoom.transform, d3.zoomIdentity.translate(tx,ty).scale(scale));
}
function resetView() {
  selectedId = null; centerId = null; renderedNodes = []; renderedLinks = [];
  if (simulation) simulation.stop();
  g.select('.links').selectAll('line').remove();
  g.select('.nodes').selectAll('circle').remove();
  g.select('.labels').selectAll('text').remove();
  linkSel = g.select('.links').selectAll('line'); nodeSel = g.select('.nodes').selectAll('circle'); labelSel = g.select('.labels').selectAll('text');
  $('#searchInput').value=''; query='';
  activeTypes = new Set(Object.keys(graph.meta.typeCounts)); activeDirections = new Set(Object.keys(graph.meta.directionCounts));
  document.querySelectorAll('.chips button').forEach(b=>b.classList.add('active'));
  hideResults(); renderEmpty(); renderEmptyDetail();
  svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity);
}
function renderEmpty(){ $('#graphEmpty').hidden = false; $('#renderedStats').textContent = 'No local graph rendered yet.'; }
function showTooltip(event,d) { const tt=$('#tooltip'); tt.hidden=false; tt.innerHTML=`<b>${esc(labelType(d.type))}</b><br>${esc(trim(d.label,160))}${d.evidenceCount?`<br>Evidence: ${d.evidenceCount}`:''}`; moveTooltip(event); }
function moveTooltip(event) { const tt=$('#tooltip'), box=$('#graphWrap').getBoundingClientRect(); tt.style.left = `${event.clientX-box.left+14}px`; tt.style.top = `${event.clientY-box.top+14}px`; }
function hideTooltip(){ $('#tooltip').hidden=true; }
function renderEmptyDetail(){ $('#detailPanel').innerHTML = `<div class="empty-state"><div class="orb"></div><h2>Select a node</h2><p>Click a node or search result for full details. Use “Set as center” to continue exploring from any entity.</p></div>`; }
function renderDetail(n) {
  if (!n) return renderEmptyDetail();
  const entityLike = n.type !== 'claim';
  const pmids = (n.pmids||[]).slice(0,10).map(p => `<a class="pill" target="_blank" rel="noreferrer" href="https://pubmed.ncbi.nlm.nih.gov/${esc(p)}/">PMID ${esc(p)}</a>`).join('');
  const dose = n.doseInfo ? Object.entries(n.doseInfo).filter(([,v])=>v!==null && v!=='' && v!==undefined).map(([k,v]) => `<span>${esc(k)}</span><span>${esc(String(v))}</span>`).join('') : '';
  const evs = (n.evidenceList||[]).slice(0,6).map(e => `<div class="evidence-card"><a target="_blank" rel="noreferrer" href="https://pubmed.ncbi.nlm.nih.gov/${esc(e.pmid||'')}/">PMID ${esc(e.pmid||'')}</a><div>${esc(e.study_type||'study')} · confidence ${esc(e.confidence||'n/a')}</div>${e.effect_size?`<div>Effect: ${esc(e.effect_size)}</div>`:''}${e.p_value?`<div>p: ${esc(e.p_value)}</div>`:''}${e.confidence_interval?`<div>CI: ${esc(e.confidence_interval)}</div>`:''}${e.evidence_snippet?`<p>${esc(e.evidence_snippet)}</p>`:''}</div>`).join('');
  $('#detailPanel').innerHTML = `
    <h2>${esc(n.label)}</h2>
    <div><span class="pill" style="color:${colorFor(n.type)}">● ${labelType(n.type)}</span>${n.direction?`<span class="pill" style="color:${DIRECTION[n.direction]||DIRECTION.unknown}">${esc(n.direction)}</span>`:''}${n.effectDirection && n.effectDirection !== n.direction ? `<span class="pill">effect ${esc(n.effectDirection)}</span>` : ''}<span class="pill">degree ${n.degree}</span></div>
    ${entityLike?`<button class="primary-detail" id="setCenterBtn">Set as center</button>`:''}
    ${n.claimText?`<div class="detail-block"><h3>Claim</h3><p>${esc(n.claimText)}</p></div>`:''}
    <div class="detail-block"><h3>Node details</h3><div class="kv">
      ${n.subject?`<span>Subject</span><span>${esc(n.subject)} ${n.subjectType?`(${esc(n.subjectType)})`:''}</span>`:''}
      ${n.object?`<span>Object</span><span>${esc(n.object)} ${n.objectType?`(${esc(n.objectType)})`:''}</span>`:''}
      ${n.confidenceScore!==null && n.confidenceScore!==undefined?`<span>Confidence</span><span>${esc(String(n.confidenceScore))}</span>`:''}
      ${n.evidenceCount?`<span>Evidence count</span><span>${esc(String(n.evidenceCount))}</span>`:''}
      <span>ID</span><span>${esc(n.id)}</span>
    </div></div>
    ${dose?`<div class="detail-block"><h3>Dose / duration</h3><div class="kv">${dose}</div></div>`:''}
    ${pmids?`<div class="detail-block"><h3>PubMed</h3><div>${pmids}</div></div>`:''}
    ${evs?`<div class="detail-block"><h3>Evidence preview</h3><div class="evidence">${evs}</div></div>`:''}
  `;
  const btn = $('#setCenterBtn');
  if (btn) btn.addEventListener('click', () => renderLocalGraph(n.id));
}
function colorFor(t){ return COLORS[t] || COLORS.default; }
function labelType(t){ return (t||'unknown').replaceAll('_',' '); }
function trim(s,n){ s = String(s||''); return s.length>n ? s.slice(0,n-1)+'…' : s; }
function esc(s){ return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
