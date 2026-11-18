// The skac runtime for apps (skac docs app): import from 'skia-motion-agentic-cli/runtime'. The machine core and the
// motion engine are the same files the CLI checks with (templates/motion/); useMachine plays a machine on the UI thread.
export * from '../templates/motion/motion';
export * from '../templates/motion/face';
export * from '../templates/motion/machine';
export { useMachine, type MachineHandle, type MachineOptions, type MachineProbe } from './useMachine';
export { runtimeVersion } from './version';
