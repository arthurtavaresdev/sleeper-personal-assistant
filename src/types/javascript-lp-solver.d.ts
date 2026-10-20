declare module 'javascript-lp-solver' {
  interface Model {
    optimize: string;
    opType: 'max' | 'min';
    constraints: Record<string, { max?: number; min?: number; equal?: number }>;
    variables: Record<string, Record<string, number>>;
    ints?: Record<string, 1>;
  }
  const solver: { Solve(model: Model): Record<string, number | boolean> };
  export default solver;
}
