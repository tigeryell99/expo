import { Command } from '@expo/commander';
import JsonFile from '@expo/json-file';
import spawnAsync from '@expo/spawn-async';
import assert from 'assert';
import fs from 'fs-extra';
import glob from 'glob-promise';
import path from 'path';

import { EXPO_DIR, EXPOTOOLS_DIR } from '../Constants';
import logger from '../Logger';
import { getPackageViewAsync } from '../Npm';
import { transformFileAsync } from '../Transforms';
import { applyPatchAsync } from '../Utils';
import { installAsync as workspaceInstallAsync } from '../Workspace';

const PATCHES_ROOT = path.join(EXPOTOOLS_DIR, 'src', 'react-native-nightlies', 'patches');

export default (program: Command) => {
  program
    .command('setup-react-native-nightly')
    .description('Setup expo/expo monorepo to install react-native nightly build for testing')
    .asyncAction(main);
};

async function main() {
  const nightlyVersion = (await getPackageViewAsync('react-native'))?.['dist-tags'].nightly;
  if (!nightlyVersion) {
    throw new Error('Unable to get react-native nightly version.');
  }

  logger.info('Adding bare-expo optional packages:');
  await addBareExpoOptionalPackagesAsync();

  logger.info('Adding pinned packages:');
  const pinnedPackages = {
    'react-native': nightlyVersion,
  };
  await addPinnedPackagesAsync(pinnedPackages);

  logger.info('Yarning...');
  await workspaceInstallAsync();

  await updateReactNativePackageAsync();

  await patchReanimatedAsync(nightlyVersion);
  await patchDetoxAsync();

  logger.info('Setting up Expo modules files');
  await updateExpoModulesAsync();

  logger.info('Setting up project files for bare-expo.');
  await updateBareExpoAsync(nightlyVersion);
}

/**
 * To save the CI build time, some third-party libraries are intentionally not listed as dependencies in bare-expo.
 * Adding these packages for nightly testing to increase coverage.
 */
async function addBareExpoOptionalPackagesAsync() {
  const bareExpoRoot = path.join(EXPO_DIR, 'apps', 'bare-expo');
  const OPTIONAL_PKGS = ['@shopify/react-native-skia', 'lottie-react-native', 'react-native-maps'];

  const packageJsonNCL = await JsonFile.readAsync(
    path.join(EXPO_DIR, 'apps', 'native-component-list', 'package.json')
  );
  const versionMap = {
    ...(packageJsonNCL.devDependencies as object),
    ...(packageJsonNCL.dependencies as object),
  };

  const installPackages = OPTIONAL_PKGS.map((pkg) => {
    const version = versionMap[pkg];
    assert(version);
    return `${pkg}@${version}`;
  });
  for (const pkg of installPackages) {
    logger.log('  ', pkg);
  }

  await spawnAsync('yarn', ['add', ...installPackages], { cwd: bareExpoRoot });
}

async function addPinnedPackagesAsync(packages: Record<string, string>) {
  const workspacePackageJsonPath = path.join(EXPO_DIR, 'package.json');
  const json = await JsonFile.readAsync(workspacePackageJsonPath);
  json.resolutions ||= {};
  for (const [name, version] of Object.entries(packages)) {
    logger.log('  ', `${name}@${version}`);
    json.resolutions[name] = version;
  }
  await JsonFile.writeAsync(workspacePackageJsonPath, json);
}

async function updateReactNativePackageAsync() {
  const reactNativeRoot = path.join(EXPO_DIR, 'node_modules', 'react-native');

  // Update native ReactNativeVersion
  const versions = (process.env.REACT_NATIVE_OVERRIDE_VERSION ?? '9999.9999.9999').split('.');
  await transformFileAsync(
    path.join(
      reactNativeRoot,
      'ReactAndroid/src/main/java/com/facebook/react/modules/systeminfo/ReactNativeVersion.java'
    ),
    [
      {
        find: /("major", )\d+,/g,
        replaceWith: `$1${versions[0]},`,
      },
      {
        find: /("minor", )\d+,/g,
        replaceWith: `$1${versions[1]},`,
      },
      {
        find: /("patch", )\d+,/g,
        replaceWith: `$1${versions[2]},`,
      },
    ]
  );

  // Workaround build error for React-bridging depending on butter
  const bridgingFiles = await glob('ReactCommon/react/bridging/*.{h,cpp}', {
    cwd: reactNativeRoot,
    absolute: true,
  });
  await Promise.all(
    bridgingFiles.map((file) =>
      transformFileAsync(file, [
        {
          find: /<butter\/map\.h>/g,
          replaceWith: '<map>',
        },
        {
          find: /<butter\/function\.h>/g,
          replaceWith: '<functional>',
        },
        {
          find: /butter::(map|function)/g,
          replaceWith: 'std::$1',
        },
      ])
    )
  );
}

async function patchReanimatedAsync(nightlyVersion: string) {
  const root = path.join(EXPO_DIR, 'node_modules', 'react-native-reanimated');

  await transformFileAsync(path.join(root, 'android', 'build.gradle'), [
    {
      find: /\$minor/g,
      replaceWith: '$rnMinorVersion',
    },
  ]);

  await transformFileAsync(path.join(root, 'RNReanimated.podspec'), [
    {
      find: /^(\s*['"]USE_HEADERMAP['"]\s+=>\s+['"]YES['"],\s*)$/gm,
      replaceWith: `$1\n    "CLANG_CXX_LANGUAGE_STANDARD" => "c++17",`,
    },
  ]);
}

async function patchDetoxAsync() {
  const patchFile = path.join(PATCHES_ROOT, 'detox.patch');
  const patchContent = await fs.readFile(patchFile, 'utf8');
  await applyPatchAsync({ patchContent, cwd: EXPO_DIR, stripPrefixNum: 1 });
}

async function updateExpoModulesAsync() {
  await transformFileAsync(
    path.join(EXPO_DIR, 'packages/expo-modules-core/android/src/main/cpp/MethodMetadata.cpp'),
    [
      {
        // Workaround build error for CallbackWrapper interface change:
        // https://github.com/facebook/react-native/commit/229a1ded15772497fd632c299b336566d001e37d
        find: 'auto weakWrapper = react::CallbackWrapper::createWeak(strongLongLiveObjectCollection,',
        replaceWith: 'auto weakWrapper = react::CallbackWrapper::createWeak(',
      },
    ]
  );
}

async function updateBareExpoAsync(nightlyVersion: string) {
  const root = path.join(EXPO_DIR, 'apps', 'bare-expo');
  await transformFileAsync(path.join(root, 'android', 'settings.gradle'), [
    {
      find: /react-native-gradle-plugin/g,
      replaceWith: '@react-native/gradle-plugin',
    },
  ]);
}
