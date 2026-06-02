/**
 * Base webpack config for the web renderer process
 */

import { join } from 'path'
import TsconfigPathsPlugins from 'tsconfig-paths-webpack-plugin'
import webpack from 'webpack'

import webpackPaths from './webpack.paths'

const configuration: webpack.Configuration = {
  stats: 'errors-only',

  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
            compilerOptions: {
              module: 'esnext',
            },
          },
        },
      },
    ],
  },

  output: {
    path: webpackPaths.srcPath,
    library: {
      type: 'commonjs2',
    },
  },

  resolve: {
    extensions: ['.js', '.jsx', '.json', '.ts', '.tsx'],
    modules: [webpackPaths.srcPath, 'node_modules'],
    plugins: [
      new TsconfigPathsPlugins({
        configFile: join(__dirname, '../../tsconfig.json'),
      }),
    ],
  },

  plugins: [
    new webpack.EnvironmentPlugin({
      NODE_ENV: 'production',
    }),
  ],
}

export default configuration
