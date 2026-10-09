import Button from "@mui/material/Button";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../../lib/i18n";
import { reportError } from "../../lib/sentry";
import { EmptyState } from "../EmptyState";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Replaces the default fallback. */
  fallback?: (error: unknown, reset: () => void) => ReactNode;
  onError?(error: unknown): void;
  /** Changing this value clears a caught error (e.g. the location key). */
  resetKey?: string;
}

interface State {
  error: unknown;
  failed: boolean;
  resetKey: string | undefined;
}

/** Catches render errors below it, reports them, and shows the "unavailable" state. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: undefined, failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error, failed: true };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { error: undefined, failed: false, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportError(error, { componentStack: info.componentStack });
    this.props.onError?.(error);
  }

  reset = (): void => {
    this.setState({ error: undefined, failed: false });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
    return (
      <EmptyState
        type="unavailable"
        title={t("error.title")}
        body={t("error.body")}
        actions={
          <Button variant="contained" onClick={() => window.location.reload()}>
            {t("error.reload")}
          </Button>
        }
      />
    );
  }
}
