export interface RequestRow {
  id: string;
  application: string;
  status: string;
  created: string;
  updated: string;
}
export interface RequestPage {
  rows: RequestRow[];
  more: boolean;
  writeFailed: boolean;
}
export interface LogEvent {
  id: number;
  status: string;
  at: string;
  detail: string | null;
}
