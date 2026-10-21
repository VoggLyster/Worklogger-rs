import Markdown from "react-markdown";
import { openExternal } from "../lib/open";

/** Markdown with links opened in the system browser. Raw HTML in the source is dropped. */
export function Md({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <Markdown
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-accent underline decoration-accent/40 hover:decoration-accent"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (href) openExternal(href);
              }}
            >
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="text-faint">[image{alt ? `: ${alt}` : ""}]</span>,
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
