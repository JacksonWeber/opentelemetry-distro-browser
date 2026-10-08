// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export type SeverityLevel = 0 | 1 | 2 | 3 | 4;

interface EnvelopeData {
  readonly ver: 2;
  readonly properties?: Readonly<Record<string, string>>;
  readonly measurements?: Readonly<Record<string, number>>;
}

export interface RequestData extends EnvelopeData {
  readonly id: string;
  readonly name: string;
  readonly duration: string;
  readonly success: boolean;
  readonly responseCode: string;
  readonly url?: string;
}

export interface RemoteDependencyData extends EnvelopeData {
  readonly id: string;
  readonly name: string;
  readonly duration: string;
  readonly success: boolean;
  readonly resultCode: string;
  readonly type: string;
  readonly data?: string;
  readonly target?: string;
}

export interface MessageData extends EnvelopeData {
  readonly message: string;
  readonly severityLevel?: SeverityLevel;
}

export interface ExceptionData extends EnvelopeData {
  readonly exceptions: readonly {
    readonly typeName: string;
    readonly message: string;
    readonly hasFullStack: boolean;
    readonly stack?: string;
    readonly parsedStack?: readonly StackFrame[];
  }[];
  readonly severityLevel?: SeverityLevel;
}

export interface StackFrame {
  readonly level: number;
  readonly method: string;
  readonly assembly: string;
  readonly fileName: string;
  readonly line: number;
}

export interface PageViewData extends EnvelopeData {
  readonly id: string;
  readonly name: string;
  readonly url?: string;
  readonly duration?: string;
  readonly referredUri?: string;
}

export interface PageViewPerformanceData extends EnvelopeData {
  readonly name: string;
  readonly url?: string;
  readonly duration: string;
  readonly perfTotal: string;
  readonly networkConnect: string;
  readonly sentRequest: string;
  readonly receivedResponse: string;
  readonly domProcessing: string;
}

export interface CustomEventData extends EnvelopeData {
  readonly name: string;
}

export type AzureMonitorBaseData =
  | RequestData
  | RemoteDependencyData
  | MessageData
  | ExceptionData
  | PageViewData
  | PageViewPerformanceData
  | CustomEventData;

export interface AzureMonitorEnvelope<T extends AzureMonitorBaseData = AzureMonitorBaseData> {
  readonly name: string;
  readonly time: string;
  readonly iKey: string;
  readonly sampleRate: number;
  readonly tags: Readonly<Record<string, string>>;
  readonly ver: 1;
  readonly data: {
    readonly baseType:
      | "RequestData"
      | "RemoteDependencyData"
      | "MessageData"
      | "ExceptionData"
      | "PageViewData"
      | "PageviewPerformanceData"
      | "EventData";
    readonly baseData: T;
  };
}
