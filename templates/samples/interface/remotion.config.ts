import { Config } from '@remotion/cli/config';
import { enableSkia } from '@remotion/skia/enable';

Config.setVideoImageFormat('png');
// Skia's web build imports `react-native`; react-native-web stands in for it.
Config.overrideWebpackConfig((config) => {
  const skia = enableSkia(config);
  return {
    ...skia,
    resolve: { ...skia.resolve, alias: { ...skia.resolve?.alias, 'react-native$': 'react-native-web' } },
  };
});
