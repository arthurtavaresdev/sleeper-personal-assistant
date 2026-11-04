declare module 'pino-roll' {
  import type SonicBoom from 'sonic-boom';
  interface PinoRollOptions {
    file: string;
    size?: number | string;
    frequency?: 'daily' | 'hourly' | number;
    symlink?: boolean;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
    dateFormat?: string;
    mkdir?: boolean;
    sync?: boolean;
  }
  export default function build(options: PinoRollOptions): Promise<SonicBoom>;
}
