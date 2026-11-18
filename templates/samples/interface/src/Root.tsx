import { Composition } from 'remotion';
import { Interface } from './Interface';

// Register each composition here. `skac add <Name>` adds its own line.
export const Root = () => (
  <>
    <Composition id="Interface" component={Interface} width={390} height={867} fps={60} durationInFrames={360} />
  </>
);
