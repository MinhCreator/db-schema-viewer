import { config } from "zod";

// Zod probes `Function("")` to decide whether it may JIT-compile parsers. The CSP
// forbids eval, so the probe always fails and browsers report a CSP violation.
// Opting out up front keeps the same (non-JIT) behaviour without the violation.
config({ jitless: true });
