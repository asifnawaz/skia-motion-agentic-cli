import { Composition } from 'remotion';
import { Character } from './Character';

// Register each composition here. `skac add <Name>` adds its own line.
export const Root = () => (
  <>
    <Composition id="Character" component={Character} width={390} height={867} fps={60} durationInFrames={480} />
  </>
);
