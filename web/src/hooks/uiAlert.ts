export interface UiAlert {
  title: string;
  message: string;
  actionLabel?: string;
}

export function createUiAlert(title: string, message: string, actionLabel?: string): UiAlert {
  return { title, message, actionLabel };
}
