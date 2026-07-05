import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

interface CardMarkdownProps {
  text: string;
}

const components: Components = {
  h1: ({ children }) => <h1 className="kv2-markdown-heading">{children}</h1>,
  h2: ({ children }) => <h2 className="kv2-markdown-heading">{children}</h2>,
  h3: ({ children }) => <h3 className="kv2-markdown-heading">{children}</h3>,
  h4: ({ children }) => <h4 className="kv2-markdown-heading">{children}</h4>,
  h5: ({ children }) => <h5 className="kv2-markdown-heading">{children}</h5>,
  h6: ({ children }) => <h6 className="kv2-markdown-heading">{children}</h6>,
  p: ({ children }) => <p className="kv2-markdown-paragraph">{children}</p>,
  ul: ({ children }) => <ul className="kv2-markdown-list">{children}</ul>,
  ol: ({ children }) => <ol className="kv2-markdown-list">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="kv2-markdown-quote">{children}</blockquote>
  ),
  pre: ({ children }) => <pre className="kv2-markdown-code">{children}</pre>,
  code: ({ className, children }) => {
    const match = /language-([\w-]+)/.exec(className ?? '');
    const isBlock = Boolean(match) || String(children).includes('\n');
    if (isBlock) {
      return <code data-language={match?.[1]}>{children}</code>;
    }
    return <code className="kv2-markdown-inline-code">{children}</code>;
  },
  a: ({ href, children }) => {
    const safe = typeof href === 'string' && /^(https?:|mailto:)/i.test(href);
    if (!safe) {
      return <>{children}</>;
    }
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  table: ({ children }) => (
    <div className="kv2-markdown-table-wrap">
      <table className="kv2-markdown-table">{children}</table>
    </div>
  ),
};

export const CardMarkdown: React.FC<CardMarkdownProps> = ({ text }) => {
  return (
    <div className="kv2-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
};
