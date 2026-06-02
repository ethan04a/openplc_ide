import 'webpack-dev-server'

import ReactRefreshWebpackPlugin from '@pmmmwh/react-refresh-webpack-plugin'
import autoprefixer from 'autoprefixer'
import HtmlWebpackPlugin from 'html-webpack-plugin'
import MonacoEditorWebpackPlugin from 'monaco-editor-webpack-plugin'
import { join } from 'path'
import tailwindcss from 'tailwindcss'
import webpack from 'webpack'
import { merge } from 'webpack-merge'

import checkNodeEnv from '../../scripts/check-node-env'
import { getAppInfoDefines } from './webpack.app-info'
import baseConfig from './webpack.config.renderer.base'
import webpackPaths from './webpack.paths'

// When an ESLint server is running, we can't set the NODE_ENV so we'll check if it's
// at the dev webpack config is not accidentally run in a production environment
if (process.env.NODE_ENV === 'production') {
  checkNodeEnv('development')
}

const port = process.env.PORT || 1212

interface ICustomConfiguration extends webpack.Configuration {
  devServer?: object
}

const configuration: ICustomConfiguration = {
  devtool: 'inline-source-map',

  mode: 'development',

  target: 'web',

  entry: [
    `webpack-dev-server/client?http://localhost:${port}`,
    'webpack/hot/only-dev-server',
    join(webpackPaths.srcRendererPath, 'index.tsx'),
  ],

  output: {
    path: webpackPaths.distRendererPath,
    publicPath: '/',
    filename: 'renderer.dev.js',
    library: {
      type: 'umd',
    },
  },

  module: {
    rules: [
      {
        test: /\.s?(c|a)ss$/,
        use: [
          'style-loader',
          {
            loader: 'css-loader',
            options: {
              modules: true,
              sourceMap: true,
              importLoaders: 1,
            },
          },
          'sass-loader',
        ],
        include: /\.module\.s?(c|a)ss$/,
      },
      {
        test: /\.s?css$/,
        use: [
          'style-loader',
          'css-loader',
          'sass-loader',
          {
            loader: 'postcss-loader',
            options: {
              postcssOptions: {
                plugins: [tailwindcss, autoprefixer],
              },
            },
          },
        ],
        exclude: /\.module\.s?(c|a)ss$/,
      },
      // Fonts
      {
        test: /\.(woff|woff2|eot|ttf|otf)$/i,
        type: 'asset/resource',
      },
      // Images
      {
        test: /\.(png|jpg|jpeg|gif)$/i,
        type: 'asset/resource',
      },
      // SVG
      {
        test: /\.svg$/,
        use: [
          {
            loader: '@svgr/webpack',
            options: {
              prettier: false,
              svgo: false,
              svgoConfig: {
                plugins: [{ removeViewBox: false }],
              },
              titleProp: true,
              ref: true,
            },
          },
          'file-loader',
        ],
      },
    ],
  },

  resolve: {
    extensions: ['.ts', '.js'],
  },
  plugins: [
    new ReactRefreshWebpackPlugin(),

    new HtmlWebpackPlugin({
      filename: join('index.html'),
      template: join(webpackPaths.srcRendererPath, 'index.ejs'),
      minify: {
        collapseWhitespace: true,
        removeAttributeQuotes: true,
        removeComments: true,
      },
      isBrowser: false,
      env: process.env.NODE_ENV,
      isDevelopment: process.env.NODE_ENV !== 'production',
    }),

    new MonacoEditorWebpackPlugin({
      languages: ['python'],
    }),

    new webpack.EnvironmentPlugin({
      NODE_ENV: 'development',
    }),

    new webpack.DefinePlugin({
      ...getAppInfoDefines(),
    }),
  ],

  node: {
    __dirname: false,
    __filename: false,
  },

  devServer: {
    port,
    compress: true,
    hot: true,
    headers: { 'Access-Control-Allow-Origin': '*' },
    static: {
      publicPath: '/',
    },
    historyApiFallback: {
      verbose: true,
    },
    proxy: [
      {
        context: ['/api'],
        target: 'http://localhost:3001',
        ws: true,
      },
    ],
  },
}

export default merge(baseConfig, configuration)
