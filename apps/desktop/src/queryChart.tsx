/**
 * A [`Plot`] as SVG, and nothing else.
 *
 * Every number here was worked out in `query.ts`; this places elements at the coordinates it
 * was given. That split is what lets the awkward parts of a chart — where a tick belongs,
 * which labels would overprint, whether the axis starts at zero — be tested as arithmetic
 * rather than by measuring a drawing.
 *
 * Nothing carries a `style` attribute. The packaged app's Content Security Policy carries a
 * nonce in `style-src`, which makes the browser drop every inline style on the page, so the
 * colours come from the stylesheet through class names and the geometry from SVG's own
 * attributes — which are attributes, not style, and survive.
 */

import "./queryChart.css";

import type { ReactNode } from "react";

import type { Plot } from "./query";

/** How far a tick's label sits from the axis it belongs to. */
const LABEL_GAP = 8;

export function QueryChart({ plot }: { plot: Plot }): ReactNode {
  const bottom = plot.height - plot.frame.bottom;
  const right = plot.width - plot.frame.right;
  const drawn = plot.bars.length + plot.points.length;

  return (
    <svg
      className="chart" viewBox={`0 0 ${plot.width} ${plot.height}`}
      preserveAspectRatio="xMidYMid meet" role="img"
      aria-label={`${plot.yLabel} by ${plot.xLabel}, as a ${plot.shape} chart of ${drawn} values`}
    >
      {/* The horizontals first, so everything drawn afterwards sits on top of them. */}
      {plot.yTicks.map((tick) => (
        <g key={`y-${tick.label}-${tick.at}`}>
          <line
            className="chart-grid" x1={plot.frame.left} x2={right} y1={tick.at} y2={tick.at}
          />
          <text
            className="chart-tick chart-tick-y" x={plot.frame.left - LABEL_GAP} y={tick.at}
            textAnchor="end" dominantBaseline="middle"
          >{tick.label}</text>
        </g>
      ))}

      <line
        className="chart-axis" x1={plot.frame.left} x2={right} y1={bottom} y2={bottom}
      />

      {plot.xTicks.map((tick) => (
        <text
          key={`x-${tick.label}-${tick.at}`} className="chart-tick" x={tick.at}
          y={bottom + LABEL_GAP} textAnchor="middle" dominantBaseline="hanging"
        >{tick.label}</text>
      ))}

      {plot.bars.map((bar) => (
        <rect
          key={bar.row} className="chart-bar" x={bar.x} y={bar.y}
          width={bar.width} height={bar.height} rx="2" data-tip={bar.tip}
        />
      ))}

      {plot.path ? <path className="chart-line" d={plot.path} /> : null}

      {plot.points.map((point) => (
        <circle
          key={point.row} className="chart-dot" cx={point.x} cy={point.y} r="4"
          data-tip={point.tip}
        />
      ))}

      {/* The axis names, the vertical one turned to run up its own axis. */}
      <text
        className="chart-axis-label" x={(plot.frame.left + right) / 2}
        y={plot.height - 6} textAnchor="middle"
      >{plot.xLabel}</text>
      <text
        className="chart-axis-label" x={14} y={(plot.frame.top + bottom) / 2}
        textAnchor="middle" transform={`rotate(-90 14 ${(plot.frame.top + bottom) / 2})`}
      >{plot.yLabel}</text>
    </svg>
  );
}
