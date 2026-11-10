import type { MergeProgress } from '../shared/mergeProtocol';

export interface MergeOverview {
  operation: string;
  operationId: string;
  files: { path: string; kind: string }[];
}

export interface MergeDocument {
  id: string;
  path: string;
  base: string;
  left: string;
  right: string;
  working: string | null;
  leftTitle: string;
  rightTitle: string;
  leftStage: number;
  leftPresent: boolean;
  rightPresent: boolean;
  editable: boolean;
  reason: string;
  markerSize: number;
  progress: MergeProgress | null;
}
