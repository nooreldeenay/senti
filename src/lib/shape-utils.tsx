'use client';

import { useState, useRef, useEffect } from "react";
import {
  Geometry2d,
  HTMLContainer,
  RecordProps,
  Rectangle2d,
  ShapeUtil,
  T,
  TLShape,
  resizeBox,
  TLResizeInfo,
} from "tldraw";
import katex from "katex";
import "katex/dist/katex.min.css";
import mermaid from 'mermaid';
import functionPlot from 'function-plot';

// ---------------------------------------------------------------------------
// Shape type constants
// ---------------------------------------------------------------------------
export const MY_LATEX_SHAPE_TYPE = 'latex' as const;
export const MY_MERMAID_SHAPE_TYPE = 'mermaid' as const;
export const MY_CHART_SHAPE_TYPE = 'chart' as const;

// ---------------------------------------------------------------------------
// Global type augmentation for tldraw
// ---------------------------------------------------------------------------
declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [MY_LATEX_SHAPE_TYPE]: { w: number; h: number; latex: string; label: string };
    [MY_MERMAID_SHAPE_TYPE]: { w: number; h: number; code: string };
    [MY_CHART_SHAPE_TYPE]: { w: number; h: number; config: any };
  }
}

// ---------------------------------------------------------------------------
// LaTeX Shape
// ---------------------------------------------------------------------------
type ILatexShape = TLShape<typeof MY_LATEX_SHAPE_TYPE>;

export class LatexShapeUtil extends ShapeUtil<ILatexShape> {
  static override type = MY_LATEX_SHAPE_TYPE;
  static override props: RecordProps<ILatexShape> = {
    w: T.number,
    h: T.number,
    latex: T.string,
    label: T.string,
  };

  override getDefaultProps(): ILatexShape['props'] {
    return { w: 300, h: 120, latex: '', label: '' };
  }

  override canEdit() { return false; }
  override canResize() { return true; }
  override isAspectRatioLocked() { return false; }

  override getGeometry(shape: ILatexShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  override onResize(shape: any, info: TLResizeInfo<any>) {
    return resizeBox(shape, info);
  }

  override component(shape: ILatexShape) {
    const katexHtml = katex.renderToString(shape.props.latex, {
      throwOnError: false,
      displayMode: true,
    });

    return (
      <HTMLContainer style={{
        backgroundColor: 'white',
        padding: '16px 24px',
        borderRadius: '12px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        border: '1px solid #eee',
      }}>
        {shape.props.label && (
          <div style={{
            fontFamily: 'sans-serif',
            fontSize: '12px',
            color: '#666',
            marginBottom: '8px',
            fontWeight: 600,
            textAlign: 'center',
          }}>
            {shape.props.label}
          </div>
        )}
        <div dangerouslySetInnerHTML={{ __html: katexHtml }} />
      </HTMLContainer>
    );
  }

  override indicator(shape: ILatexShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx="12" ry="12" />;
  }
}

// ---------------------------------------------------------------------------
// Mermaid Shape
// ---------------------------------------------------------------------------
type IMermaidShape = TLShape<typeof MY_MERMAID_SHAPE_TYPE>;

export class MermaidShapeUtil extends ShapeUtil<IMermaidShape> {
  static override type = MY_MERMAID_SHAPE_TYPE;
  static override props: RecordProps<IMermaidShape> = {
    w: T.number,
    h: T.number,
    code: T.string,
  };

  override getDefaultProps(): IMermaidShape['props'] {
    return { w: 400, h: 300, code: 'graph TD; A-->B;' };
  }

  override canEdit() { return false; }
  override canResize() { return true; }

  override getGeometry(shape: IMermaidShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  override onResize(shape: any, info: TLResizeInfo<any>) {
    return resizeBox(shape, info);
  }

  override component(shape: IMermaidShape) {
    const [svg, setSvg] = useState<string>('');
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      let isMounted = true;
      const render = async () => {
        try {
          const id = `mermaid-${shape.id.replace(/:/g, '-')}`;
          let { svg: svgContent } = await mermaid.render(id, shape.props.code);
          // Force SVG to fill container without conflicting styles (fixes diagram flicker)
          svgContent = svgContent
            .replace(/(<svg[^>]*)width="[^"]*"/i, '$1')
            .replace(/(<svg[^>]*)height="[^"]*"/i, '$1')
            .replace(/(<svg[^>]*)style="[^"]*"/i, '$1')
            .replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="width: 100%; height: 100%; object-fit: contain;" ');
          if (isMounted) setSvg(svgContent);
        } catch (e) {
          console.error('[MermaidShape] Render error:', e);
        }
      };
      render();
      return () => { isMounted = false; };
    }, [shape.props.code, shape.id]);

    return (
      <HTMLContainer style={{
        backgroundColor: 'white',
        padding: '16px',
        borderRadius: '12px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        border: '1px solid #eee',
      }}>
        <div
          ref={containerRef}
          style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </HTMLContainer>
    );
  }

  override indicator(shape: IMermaidShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx="12" ry="12" />;
  }
}

// ---------------------------------------------------------------------------
// Chart (Function Plot) Shape
// ---------------------------------------------------------------------------
type IChartShape = TLShape<typeof MY_CHART_SHAPE_TYPE>;

export class ChartShapeUtil extends ShapeUtil<IChartShape> {
  static override type = MY_CHART_SHAPE_TYPE;
  static override props: RecordProps<IChartShape> = {
    w: T.number,
    h: T.number,
    config: T.any,
  };

  override getDefaultProps(): IChartShape['props'] {
    return {
      w: 400,
      h: 300,
      config: { title: 'Function Plot', data: [{ fn: 'x^2', color: 'blue' }] },
    };
  }

  override canEdit() { return false; }
  override canResize() { return true; }

  override getGeometry(shape: IChartShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  override onResize(shape: any, info: TLResizeInfo<any>) {
    return resizeBox(shape, info);
  }

  override component(shape: IChartShape) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (!containerRef.current) return;
      try {
        const { title, functions, data, xRange, yRange, ...rest } = shape.props.config;
        const config: any = {
          target: containerRef.current,
          width: shape.props.w - 40,
          height: shape.props.h - 80,
          grid: true,
          // Deep clone data so function-plot can mutate it freely
          data: JSON.parse(JSON.stringify(functions || data || [])),
          ...rest,
        };
        if (xRange) config.xAxis = { domain: xRange };
        if (yRange) config.yAxis = { domain: yRange };
        delete config.title; // Rendered manually below
        functionPlot(config);
      } catch (e) {
        console.error('[ChartShape] FunctionPlot render error:', e);
      }
    }, [shape.props.config, shape.props.w, shape.props.h]);

    return (
      <HTMLContainer style={{
        backgroundColor: 'white',
        padding: '16px',
        borderRadius: '12px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        border: '1px solid #eee',
      }}>
        {shape.props.config.title && (
          <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '8px', color: '#333' }}>
            {shape.props.config.title}
          </div>
        )}
        <div ref={containerRef} />
      </HTMLContainer>
    );
  }

  override indicator(shape: IChartShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx="12" ry="12" />;
  }
}

// ---------------------------------------------------------------------------
// Convenience export
// ---------------------------------------------------------------------------
export const customShapeUtils = [LatexShapeUtil, MermaidShapeUtil, ChartShapeUtil];
