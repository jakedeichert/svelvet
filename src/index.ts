/* eslint-disable no-console */
import * as util from 'util';
import { exec as execSync } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as svelte from 'svelte/compiler';
import * as chokidar from 'chokidar';
import * as babel from '@babel/core';
import * as glob from 'glob';
import pLimit from 'p-limit';

const exec = util.promisify(execSync);

const IS_PRODUCTION_MODE = process.env.NODE_ENV === 'production';

async function compile(file: string): Promise<string | null> {
    try {
        const source = await fs.readFile(file, 'utf8');
        const isSvelte = file.endsWith('.svelte');

        // Don't compile non-svelte files
        const compiled = isSvelte
            ? svelte.compile(source, {
                  dev: !IS_PRODUCTION_MODE,
              }).js.code
            : source;

        // Create all ancestor directories for this file
        const destPath = file
            .replace(/^src\//, 'dist/')
            .replace(/.svelte$/, '.js');

        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, compiled);

        // Don't compile/transpile any non-js files
        if (!destPath.endsWith('.js') && !destPath.endsWith('.mjs')) {
            return null;
        }

        console.info(`Svelte compiled ${destPath}`);

        return destPath;
    } catch (err) {
        console.log('');
        console.error(`Failed to compile with svelte: ${file}`);
        console.error(err);
        console.log('');
        return null;
    }
}

// Update the import paths to correctly point to web_modules.
async function transform(destPath: string): Promise<void> {
    try {
        const source = await fs.readFile(destPath, 'utf8');

        const transformed = (await babel.transformAsync(source, {
            plugins: [
                [
                    'snowpack/assets/babel-plugin.js',
                    {
                        // Append .js to all src file imports
                        optionalExtensions: true,
                    },
                ],
            ],
        })) as babel.BabelFileResult;

        await fs.writeFile(destPath, transformed.code);
        console.info(`Babel transformed ${destPath}`);
    } catch (err) {
        console.log('');
        console.error(`Failed to transform with babel: ${destPath}`);
        console.error(err);
        console.log('');
    }
}

// Only needs to run during the initial compile cycle. If a developer adds a new package dependency,
// they should restart svelvet.
const snowpack = async (): Promise<void> => {
    const maybeOptimize = IS_PRODUCTION_MODE ? '--optimize' : '';

    console.info(`\nBuilding web_modules with snowpack...`);

    try {
        const snowpackLocation = path.resolve(
            require.resolve('snowpack'),
            '../index.bin.js'
        );

        const { stdout, stderr } = await exec(
            `${snowpackLocation} --include 'dist/**/*' --dest dist/web_modules ${maybeOptimize}`
        );

        // TODO: hide behind --verbose flag
        // Show any output from snowpack...
        stdout && console.info(stdout);
        stderr && console.info(stderr);
    } catch (err) {
        console.log('');
        console.error('Failed to build with snowpack');
        console.error(err);
        console.log('');
    }
};

async function initialBuild(): Promise<void> {
    if (IS_PRODUCTION_MODE) console.info(`Building in production mode...`);

    const concurrentCompilationLimit = pLimit(8);

    const srcFiles = glob.sync('src/**', {
        nodir: true,
    });

    // Compile all source files with svelte.
    const destFiles = await Promise.all(
        srcFiles.map(srcPath =>
            concurrentCompilationLimit(async () => {
                const destPath = await compile(srcPath);
                return destPath;
            })
        )
    );

    // Need to run (only once) before transforming the import paths, or else it will fail.
    await snowpack();

    // Transform all js files with babel.
    await Promise.all(
        destFiles.map(destPath =>
            concurrentCompilationLimit(async () => {
                if (!destPath) return;
                await transform(destPath);
            })
        )
    );
}

function startWatchMode(): void {
    console.info(`Watching for files...`);
    const srcWatcher = chokidar.watch('src');

    srcWatcher.on('change', async (path: string) => {
        const destPath = await compile(path);
        if (!destPath) return;
        transform(destPath);
    });
}

async function main(): Promise<void> {
    await initialBuild();
    if (!IS_PRODUCTION_MODE) startWatchMode();
}

main();
