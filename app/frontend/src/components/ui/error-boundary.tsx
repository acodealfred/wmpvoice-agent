import { Component, ErrorInfo, ReactNode } from "react";
import { AlertCircle } from "lucide-react";

interface Props {
    children: ReactNode;
    /** Rendered instead of the default message when the subtree throws. */
    fallback?: ReactNode;
    /** Short label for the default fallback, e.g. "report". */
    label?: string;
}

interface State {
    hasError: boolean;
    message?: string;
}

/**
 * Catches render-time errors in its subtree so one broken component (e.g. a
 * chart) shows an inline message instead of unmounting the whole app to a
 * blank white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false };

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, message: error.message };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("[ErrorBoundary] caught:", error, info);
    }

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) return this.props.fallback;
            return (
                <div className="flex items-start gap-2 rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4 text-sm text-[color:var(--ciq-text-body)]">
                    <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--ciq-accent-red)]" />
                    <div>
                        <p className="font-semibold text-[color:var(--ciq-text-strong)]">
                            Something went wrong loading the {this.props.label ?? "content"}.
                        </p>
                        {this.state.message && <p className="mt-1 text-xs text-[color:var(--ciq-text-muted)]">{this.state.message}</p>}
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}
