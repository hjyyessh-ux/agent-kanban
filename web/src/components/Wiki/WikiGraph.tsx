import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-2d';
import type { KanbanCard, WikiDocType } from '../../../../src/core/types';
import type { WikiTile } from './WikiView';
import './WikiGraph.css';

const TYPE_ORDER: { key: WikiDocType; label: string }[] = [
  { key: 'troubleshooting', label: 'Trouble' },
  { key: 'howto', label: 'How-to' },
  { key: 'decision', label: 'Decision' },
  { key: 'concept', label: 'Concept' },
  { key: 'reference', label: 'Reference' },
];

type NodeKind = 'doc' | 'project' | 'topic';
type DocShape = 'square' | 'circle';

/**
 * Everything tunable from the in-graph gear panel. All visuals/forces read from
 * here, so the panel can change them live. Persisted to localStorage.
 */
interface GraphConfig {
  nodeScale: number;       // global node size multiplier (radius = sqrt(val) * nodeScale)
  charge: number;          // d3 repulsion strength (negative — more negative = more spread)
  linkDistance: number;    // d3 link length (distance between connected nodes)
  borderFactor: number;    // node border thickness, relative to radius
  shadowFactor: number;    // hard-shadow offset, relative to radius
  labelSize: number;       // base label font size (px at 1× zoom)
  labelZoom: number;       // doc/topic labels turn on once zoom passes this
  topicThreshold: number;  // min docs sharing a topic before it becomes a hub
  docShape: DocShape;      // document node shape
  showProjects: boolean;   // render project hubs + their links
  showTopics: boolean;     // render topic hubs + their links
  projectColor: string;
  topicColor: string;
  typeColors: Record<WikiDocType, string>;
}

/**
 * Theme-driven canvas colours. The page background + structural ink (node
 * borders/shadows/label text) must follow light/dark mode, so they are read
 * live from the kv2 tokens at draw time rather than persisted in GraphConfig
 * (the categorical type/project/topic colours below stay user-tunable —
 * they are brand/data-viz, invariant across themes).
 */
interface ThemeColors {
  background: string;
  borderColor: string;
}

function readThemeColors(): ThemeColors {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: get('--kv2-app-bg', '#FFF8E7'),
    borderColor: get('--kv2-text-primary', '#1A1A2E'),
  };
}

/** Parse a `#rgb`/`#rrggbb` token value into [r, g, b] for building rgba links. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Defaults mirror styles/tokens.css + Wiki.css and reproduce the original look. */
const DEFAULT_CONFIG: GraphConfig = {
  nodeScale: 4,
  charge: -90,
  linkDistance: 32,
  borderFactor: 0.16,
  shadowFactor: 0.32,
  labelSize: 11,
  labelZoom: 1.4,
  topicThreshold: 2,
  docShape: 'square',
  showProjects: true,
  showTopics: true,
  projectColor: '#0066FF',
  topicColor: '#8d8da3',
  typeColors: {
    troubleshooting: '#e74c3c',
    howto: '#3498db',
    decision: '#9b59b6',
    concept: '#16a085',
    reference: '#e67e22',
  },
};

const STORAGE_KEY = 'wiki-graph-config-v1';

function loadConfig(): GraphConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<GraphConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      typeColors: { ...DEFAULT_CONFIG.typeColors, ...(parsed.typeColors ?? {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  val: number;
  degree: number;
  docType?: WikiDocType;
  card?: KanbanCard;
}

interface GraphLink {
  source: string;
  target: string;
  kind: 'project' | 'topic';
}

interface WikiGraphProps {
  tiles: WikiTile[];
  onSelect: (card: KanbanCard) => void;
}

/** Last path segment of a project directory, used as the project hub label. */
function basename(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || dir;
}

/** Resolve a link endpoint id whether it is still a string (pre-layout) or a node object (post-layout). */
function endId(end: string | number | NodeObject<GraphNode> | undefined): string {
  if (end == null) return '';
  if (typeof end === 'object') return String(end.id ?? '');
  return String(end);
}

// ─── Settings-panel rows (module-level so inputs keep focus while dragging) ───
function SliderRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  display?: string;
}) {
  return (
    <label className="wgs-row">
      <span className="wgs-label">
        {props.label}
        <em>{props.display ?? props.value}</em>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function ColorRow(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="wgs-row wgs-row--color">
      <span className="wgs-label">{props.label}</span>
      <input type="color" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </label>
  );
}

/**
 * Obsidian-style knowledge graph for kept wiki documents.
 *
 * Tripartite layout (like Obsidian notes + tags):
 *  - doc nodes     → one per generated document, colored by its type
 *  - project hubs  → one per `projectDir`, pulls same-project docs into a cluster
 *  - topic hubs     → one per topic shared by ≥N docs, cross-links clusters
 *
 * All appearance/forces come from `config`, editable live via the gear panel.
 */
export function WikiGraph({ tiles, onSelect }: WikiGraphProps) {
  const fgRef = useRef<ForceGraphMethods<NodeObject<GraphNode>, LinkObject<GraphNode, GraphLink>>>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<WikiDocType>>(new Set());
  const [config, setConfig] = useState<GraphConfig>(loadConfig);
  const [themeColors, setThemeColors] = useState<ThemeColors>(readThemeColors);
  const [showSettings, setShowSettings] = useState(false);
  const didFit = useRef(false);

  // Re-read the theme-driven canvas colours whenever the theme changes; the new
  // `themeColors` object flows into paintNode/linkColor + the backgroundColor
  // prop, so react-force-graph repaints the canvas with the dark/light palette.
  useEffect(() => {
    const onThemeChange = () => setThemeColors(readThemeColors());
    window.addEventListener('kanban-theme-change', onThemeChange);
    return () => window.removeEventListener('kanban-theme-change', onThemeChange);
  }, []);

  const update = useCallback((patch: Partial<GraphConfig>) => setConfig((c) => ({ ...c, ...patch })), []);
  const updateType = useCallback(
    (key: WikiDocType, value: string) => setConfig((c) => ({ ...c, typeColors: { ...c.typeColors, [key]: value } })),
    [],
  );

  // Persist config so tweaks survive reloads.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* storage unavailable — ignore */
    }
  }, [config]);

  // ─── Size the canvas to fill from its top edge down to the viewport bottom ───
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const node = wrapRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const width = Math.floor(rect.width);
      // Fill the remaining viewport height below the graph's top edge (24px bottom gap).
      const height = Math.max(360, Math.floor(window.innerHeight - rect.top - 24));
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Observe the parent too so the height recomputes when content above (hero,
    // options drawer, stat cards) grows or shrinks and pushes the graph down/up.
    if (el.parentElement) ro.observe(el.parentElement);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // ─── Build the graph (doc / project / topic nodes + links) + adjacency ───
  const { nodes, links, adjacency } = useMemo(() => {
    const nodeMap = new Map<string, GraphNode>();
    const linkList: GraphLink[] = [];
    const adj = new Map<string, Set<string>>();
    const connect = (a: string, b: string) => {
      (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
      (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
    };

    const docTiles = tiles.filter((t) => t.card.wiki?.decision === 'kept' && t.card.wiki?.docType);

    // Count topic frequency — only topics shared by ≥threshold docs become hubs.
    const topicFreq = new Map<string, number>();
    for (const t of docTiles) {
      for (const tp of t.card.wiki?.topics ?? []) topicFreq.set(tp, (topicFreq.get(tp) ?? 0) + 1);
    }

    for (const t of docTiles) {
      const w = t.card.wiki!;
      const id = w.docPath ?? t.card.id;
      if (!nodeMap.has(id)) {
        nodeMap.set(id, {
          id,
          kind: 'doc',
          label: w.docTitle ?? t.card.title,
          docType: w.docType,
          card: t.card,
          val: 1 + (t.count - 1) * 0.6,
          degree: 0,
        });
      }

      const dir = t.card.projectDir;
      if (config.showProjects && dir) {
        const pid = `proj:${dir}`;
        if (!nodeMap.has(pid)) {
          nodeMap.set(pid, { id: pid, kind: 'project', label: basename(dir), val: 3, degree: 0 });
        }
        linkList.push({ source: id, target: pid, kind: 'project' });
        connect(id, pid);
      }

      if (config.showTopics) {
        for (const tp of w.topics ?? []) {
          if ((topicFreq.get(tp) ?? 0) < config.topicThreshold) continue;
          const tid = `topic:${tp}`;
          if (!nodeMap.has(tid)) {
            nodeMap.set(tid, { id: tid, kind: 'topic', label: `#${tp}`, val: 1.5, degree: 0 });
          }
          linkList.push({ source: id, target: tid, kind: 'topic' });
          connect(id, tid);
        }
      }
    }

    // Degree-based sizing for hubs.
    for (const [id, set] of adj) {
      const n = nodeMap.get(id);
      if (!n) continue;
      n.degree = set.size;
      if (n.kind === 'project') n.val = 3 + Math.sqrt(set.size) * 1.3;
      else if (n.kind === 'topic') n.val = 1.2 + Math.sqrt(set.size) * 0.7;
    }

    return { nodes: [...nodeMap.values()], links: linkList, adjacency: adj };
  }, [tiles, config.topicThreshold, config.showProjects, config.showTopics]);

  // Stable references so hover/filter re-renders don't reheat the force layout.
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const graphData = useMemo(() => ({ nodes, links }), [nodes, links]);

  // Rebuild → allow a fresh zoom-to-fit once the engine settles.
  useEffect(() => {
    didFit.current = false;
  }, [nodes]);

  // Apply d3 forces (node spacing). Re-runs when spacing config or data changes,
  // and once the canvas first mounts (size becomes > 0).
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || size.width === 0) return;
    fg.d3Force('charge')?.strength(config.charge);
    fg.d3Force('link')?.distance(config.linkDistance);
    fg.d3ReheatSimulation();
  }, [config.charge, config.linkDistance, nodes, size.width]);

  const isVisible = useCallback(
    (n: NodeObject<GraphNode>): boolean => {
      if (n.kind === 'doc') return !(n.docType && hidden.has(n.docType));
      // Hubs stay visible as long as at least one visible neighbor remains.
      const neighbors = adjacency.get(String(n.id));
      if (!neighbors) return true;
      for (const nb of neighbors) {
        const doc = nodeById.get(nb);
        if (doc && doc.kind === 'doc' && !(doc.docType && hidden.has(doc.docType))) return true;
      }
      return false;
    },
    [hidden, adjacency, nodeById],
  );

  const highlight = useMemo(() => (hoverId ? adjacency.get(hoverId) ?? new Set<string>() : null), [hoverId, adjacency]);

  const nodeColor = useCallback(
    (n: NodeObject<GraphNode>): string => {
      if (n.kind === 'project') return config.projectColor;
      if (n.kind === 'topic') return config.topicColor;
      return n.docType ? config.typeColors[n.docType] : '#999';
    },
    [config.projectColor, config.topicColor, config.typeColors],
  );

  // ─── Custom neobrutalism node painter (shape + hard shadow + thick border) ───
  const paintNode = useCallback(
    (node: NodeObject<GraphNode>, ctx: CanvasRenderingContext2D, scale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const idStr = node.id != null ? String(node.id) : '';
      const isHover = hoverId === node.id;
      const isNeighbor = !!highlight?.has(idStr);
      const dimmed = !!hoverId && !isHover && !isNeighbor;
      // Hovered node grows for emphasis + an easier visual target.
      const baseR = Math.sqrt(node.val) * config.nodeScale;
      const r = isHover ? baseR * 1.45 : baseR;
      const strokeW = Math.max(0.7, r * config.borderFactor) * (isHover ? 1.4 : 1);
      const sh = Math.max(1.1, r * config.shadowFactor);
      const fill = nodeColor(node);
      const shape: DocShape = node.kind === 'topic' ? 'circle' : node.kind === 'doc' ? config.docShape : 'square';

      ctx.save();
      ctx.globalAlpha = dimmed ? 0.1 : 1;

      if (shape === 'circle') {
        ctx.beginPath();
        ctx.arc(x + sh * 0.7, y + sh * 0.7, r, 0, Math.PI * 2);
        ctx.fillStyle = themeColors.borderColor;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = themeColors.borderColor;
        ctx.stroke();
      } else {
        const s = r * 2;
        ctx.fillStyle = themeColors.borderColor;
        ctx.fillRect(x - r + sh, y - r + sh, s, s);
        ctx.fillStyle = fill;
        ctx.fillRect(x - r, y - r, s, s);
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = themeColors.borderColor;
        ctx.strokeRect(x - r, y - r, s, s);
      }

      // Single canvas label (library DOM tooltip is disabled to avoid double labels).
      // Shown for: project hubs always · hovered node + neighbors · everything past label-zoom.
      const showLabel = node.kind === 'project' || isHover || isNeighbor || scale > config.labelZoom;
      if (showLabel && !dimmed) {
        const fontSize = Math.max(3, (isHover ? config.labelSize * 1.25 : config.labelSize) / scale);
        ctx.font = `700 ${fontSize}px 'Space Grotesk', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const text = node.label.length > 32 ? `${node.label.slice(0, 31)}…` : node.label;
        const padX = fontSize * 0.5;
        const padY = fontSize * 0.32;
        const boxW = ctx.measureText(text).width + padX * 2;
        const boxH = fontSize + padY * 2;
        const cx = x;
        const cy = y + r + 2 / scale + boxH / 2;
        // Opaque neobrutalism pill keeps text readable over dense nodes/links.
        ctx.fillStyle = themeColors.background;
        ctx.fillRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
        ctx.lineWidth = Math.max(0.5, fontSize * 0.09);
        ctx.strokeStyle = themeColors.borderColor;
        ctx.strokeRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
        ctx.fillStyle = themeColors.borderColor;
        ctx.fillText(text, cx, cy);
      }
      ctx.restore();
    },
    [hoverId, highlight, nodeColor, config, themeColors],
  );

  // Pointer hit-area matches the painted shape so clicks/hover line up.
  const paintPointerArea = useCallback(
    (node: NodeObject<GraphNode>, color: string, ctx: CanvasRenderingContext2D) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      // Padded a touch beyond the visual radius so small nodes are easier to click/hover.
      const r = Math.sqrt(node.val) * config.nodeScale + 1.5;
      const shape: DocShape = node.kind === 'topic' ? 'circle' : node.kind === 'doc' ? config.docShape : 'square';
      ctx.fillStyle = color;
      if (shape === 'circle') {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    },
    [config.nodeScale, config.docShape],
  );

  // Link rgba built from the theme ink (borderColor) + topic swatch so links
  // track light/dark. In light mode these resolve to the original literals
  // (ink #1A1A2E = 26,26,46 · topic #8d8da3 = 141,141,163) — pixel-identical.
  const inkRgb = useMemo(() => hexToRgb(themeColors.borderColor), [themeColors.borderColor]);
  const topicRgb = useMemo(() => hexToRgb(config.topicColor), [config.topicColor]);

  const linkColor = useCallback(
    (link: LinkObject<GraphNode, GraphLink>): string => {
      const [ir, ig, ib] = inkRgb;
      const [tr, tg, tb] = topicRgb;
      if (hoverId) {
        const on = endId(link.source) === hoverId || endId(link.target) === hoverId;
        if (on) return link.kind === 'topic' ? `rgba(${tr},${tg},${tb},0.95)` : `rgba(${ir},${ig},${ib},0.85)`;
        return `rgba(${ir},${ig},${ib},0.04)`;
      }
      return link.kind === 'topic' ? `rgba(${tr},${tg},${tb},0.35)` : `rgba(${ir},${ig},${ib},0.18)`;
    },
    [hoverId, inkRgb, topicRgb],
  );

  const linkWidth = useCallback(
    (link: LinkObject<GraphNode, GraphLink>): number => {
      if (!hoverId) return link.kind === 'topic' ? 0.4 : 0.7;
      const on = endId(link.source) === hoverId || endId(link.target) === hoverId;
      return on ? 1.8 : 0.3;
    },
    [hoverId],
  );

  const handleClick = useCallback(
    (node: NodeObject<GraphNode>) => {
      if (node.kind === 'doc' && node.card) {
        onSelect(node.card);
        return;
      }
      const fg = fgRef.current;
      if (fg && node.x != null && node.y != null) {
        fg.centerAt(node.x, node.y, 500);
        fg.zoom(Math.max(2, fg.zoom()), 500);
      }
    },
    [onSelect],
  );

  const handleEngineStop = useCallback(() => {
    if (didFit.current) return;
    didFit.current = true;
    fgRef.current?.zoomToFit(500, 70);
  }, []);

  const zoomBy = (factor: number) => {
    const fg = fgRef.current;
    if (fg) fg.zoom(fg.zoom() * factor, 250);
  };

  const toggleType = (t: WikiDocType) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const docCount = nodes.filter((n) => n.kind === 'doc').length;
  const projectCount = nodes.filter((n) => n.kind === 'project').length;
  const topicCount = nodes.filter((n) => n.kind === 'topic').length;

  // Larger graphs settle faster with fewer ticks so the UI isn't janky.
  const cooldownTicks = nodes.length > 1200 ? 60 : nodes.length > 400 ? 100 : 160;

  return (
    <div className="wiki-graph" ref={wrapRef} style={size.height ? { height: `${size.height}px` } : undefined}>
      {docCount === 0 ? (
        <div className="wiki-graph-empty">표시할 Kept 문서가 없습니다. 검색/필터를 조정해 보세요.</div>
      ) : (
        <>
          {size.width > 0 && (
          <ForceGraph2D<GraphNode, GraphLink>
            ref={fgRef}
            width={size.width}
            height={size.height}
            graphData={graphData}
            backgroundColor={themeColors.background}
            nodeId="id"
            nodeRelSize={config.nodeScale}
            nodeVal="val"
            nodeVisibility={isVisible}
            nodeCanvasObject={paintNode}
            nodePointerAreaPaint={paintPointerArea}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkVisibility={(l) => {
              const s = nodeById.get(endId(l.source));
              const t = nodeById.get(endId(l.target));
              return (!s || isVisible(s)) && (!t || isVisible(t));
            }}
            minZoom={0.4}
            maxZoom={12}
            cooldownTicks={cooldownTicks}
            d3VelocityDecay={0.32}
            warmupTicks={nodes.length > 1200 ? 20 : 0}
            onNodeClick={handleClick}
            onNodeHover={(n) => setHoverId(n ? String(n.id) : null)}
            onEngineStop={handleEngineStop}
            enableNodeDrag
          />
          )}

          {/* ─── Filter legend (type toggles, Obsidian-style) ─── */}
          <div className="wiki-graph-legend">
            <span className="wiki-graph-legend-title">타입 필터</span>
            {TYPE_ORDER.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`wiki-graph-legend-item ${hidden.has(t.key) ? 'is-off' : ''}`}
                onClick={() => toggleType(t.key)}
                title={hidden.has(t.key) ? `${t.label} 표시` : `${t.label} 숨기기`}
              >
                <span className="wiki-graph-swatch" style={{ background: config.typeColors[t.key] }} />
                {t.label}
              </button>
            ))}
            <div className="wiki-graph-legend-divider" />
            <span className="wiki-graph-legend-meta">
              <span className="wiki-graph-swatch wiki-graph-swatch--square" style={{ background: config.projectColor }} /> 프로젝트
            </span>
            <span className="wiki-graph-legend-meta">
              <span className="wiki-graph-swatch wiki-graph-swatch--dot" style={{ background: config.topicColor }} /> 토픽
            </span>
          </div>

          {/* ─── Gear button (top-right) ─── */}
          <button
            type="button"
            className={`wiki-graph-gear ${showSettings ? 'is-active' : ''}`}
            onClick={() => setShowSettings((v) => !v)}
            title="그래프 설정"
            aria-label="그래프 설정"
            aria-expanded={showSettings}
          >⚙</button>

          {/* ─── Settings panel ─── */}
          {showSettings && (
            <div className="wiki-graph-settings">
              <div className="wgs-head">
                <span>그래프 설정</span>
                <button type="button" className="wgs-reset" onClick={() => setConfig(DEFAULT_CONFIG)} title="기본값으로 되돌리기">초기화</button>
              </div>

              <div className="wgs-section">배치</div>
              <SliderRow label="노드 간격(반발력)" value={-config.charge} display={String(-config.charge)} min={5} max={400} step={5} onChange={(v) => update({ charge: -v })} />
              <SliderRow label="링크 길이" value={config.linkDistance} min={5} max={140} step={1} onChange={(v) => update({ linkDistance: v })} />

              <div className="wgs-section">노드</div>
              <SliderRow label="크기" value={config.nodeScale} min={1} max={12} step={0.5} onChange={(v) => update({ nodeScale: v })} />
              <label className="wgs-row">
                <span className="wgs-label">문서 모양</span>
                <select className="wgs-select" value={config.docShape} onChange={(e) => update({ docShape: e.target.value as DocShape })}>
                  <option value="square">사각형</option>
                  <option value="circle">원형</option>
                </select>
              </label>
              <SliderRow label="테두리 두께" value={config.borderFactor} display={config.borderFactor.toFixed(2)} min={0} max={0.4} step={0.02} onChange={(v) => update({ borderFactor: v })} />
              <SliderRow label="그림자 오프셋" value={config.shadowFactor} display={config.shadowFactor.toFixed(2)} min={0} max={0.6} step={0.02} onChange={(v) => update({ shadowFactor: v })} />

              <div className="wgs-section">라벨</div>
              <SliderRow label="글자 크기" value={config.labelSize} min={6} max={24} step={1} onChange={(v) => update({ labelSize: v })} />
              <SliderRow label="라벨 표시 줌" value={config.labelZoom} display={`${config.labelZoom.toFixed(1)}×`} min={0.5} max={6} step={0.1} onChange={(v) => update({ labelZoom: v })} />

              <div className="wgs-section">구조</div>
              <SliderRow label="토픽 묶음 임계값" value={config.topicThreshold} display={`${config.topicThreshold}개 이상`} min={1} max={10} step={1} onChange={(v) => update({ topicThreshold: v })} />
              <label className="wgs-row wgs-row--check">
                <span className="wgs-label">프로젝트 노드</span>
                <input type="checkbox" checked={config.showProjects} onChange={(e) => update({ showProjects: e.target.checked })} />
              </label>
              <label className="wgs-row wgs-row--check">
                <span className="wgs-label">토픽 노드</span>
                <input type="checkbox" checked={config.showTopics} onChange={(e) => update({ showTopics: e.target.checked })} />
              </label>

              <div className="wgs-section">색상</div>
              {TYPE_ORDER.map((t) => (
                <ColorRow key={t.key} label={t.label} value={config.typeColors[t.key]} onChange={(v) => updateType(t.key, v)} />
              ))}
              <ColorRow label="프로젝트" value={config.projectColor} onChange={(v) => update({ projectColor: v })} />
              <ColorRow label="토픽" value={config.topicColor} onChange={(v) => update({ topicColor: v })} />
            </div>
          )}

          {/* ─── Zoom controls ─── */}
          <div className="wiki-graph-zoom">
            <button type="button" className="wiki-graph-zoombtn" onClick={() => zoomBy(1.4)} title="확대" aria-label="확대">＋</button>
            <button type="button" className="wiki-graph-zoombtn" onClick={() => zoomBy(1 / 1.4)} title="축소" aria-label="축소">－</button>
            <button
              type="button"
              className="wiki-graph-zoombtn"
              onClick={() => fgRef.current?.zoomToFit(500, 70)}
              title="전체 보기"
              aria-label="전체 보기"
            >⤢</button>
          </div>

          {/* ─── Count summary ─── */}
          <div className="wiki-graph-stat">
            문서 <strong>{docCount}</strong> · 프로젝트 <strong>{projectCount}</strong> · 토픽 <strong>{topicCount}</strong>
          </div>
        </>
      )}
    </div>
  );
}
