import { SimHostServer, type HostTimers } from "@coasterworks/protocol";
import { Sim } from "@coasterworks/sim";
import { createSamplePark } from "../dev/sample-park";
import { WorkerPortTransport, type PortLike } from "./worker-transport";

/** The sample park's seed. The same seed is the same park every time. */
const SEED = 7;

// A worker is not the sim: it is where the sim runs, so it has the real clock and real timers.
const timers: HostTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => performance.now(),
};

const host = new SimHostServer(new Sim(createSamplePark(SEED)), { timers });
host.attach(new WorkerPortTransport(self as unknown as PortLike));
// The host starts at 1x, and the loop begins now. The page says hello when it is ready.
host.start();
