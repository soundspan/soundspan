"use client";

interface RequestPaginationProps {
    page: number;
    pageCount: number;
    disabled: boolean;
    onChange: (page: number) => void;
}

const PAGE_BUTTON =
    "px-3 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed";

/** First/Prev/Next/Last pager matching the Library page; hidden for one page. */
export function RequestPagination(props: RequestPaginationProps) {
    const { page, pageCount, disabled, onChange } = props;
    if (pageCount <= 1) return null;
    const atStart = page <= 1;
    const atEnd = page >= pageCount;
    return (
        <nav
            aria-label="Requests pages"
            className="mt-6 flex items-center justify-center gap-2 border-t border-white/5 pt-4"
        >
            <button
                type="button"
                onClick={() => onChange(1)}
                disabled={atStart || disabled}
                className={PAGE_BUTTON}
            >
                First
            </button>
            <button
                type="button"
                onClick={() => onChange(Math.max(1, page - 1))}
                disabled={atStart || disabled}
                className={PAGE_BUTTON}
            >
                Prev
            </button>
            <span className="px-4 py-1.5 text-xs text-white">
                {page} / {pageCount}
            </span>
            <button
                type="button"
                onClick={() => onChange(Math.min(pageCount, page + 1))}
                disabled={atEnd || disabled}
                className={PAGE_BUTTON}
            >
                Next
            </button>
            <button
                type="button"
                onClick={() => onChange(pageCount)}
                disabled={atEnd || disabled}
                className={PAGE_BUTTON}
            >
                Last
            </button>
        </nav>
    );
}
