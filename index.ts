import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cwd, exit } from 'node:process';

import {
  error,
  getInput,
  getMultilineInput,
  group,
  setFailed,
} from '@actions/core';
import { exec } from '@actions/exec';
import { context } from '@actions/github';
import { Octokit } from '@octokit/rest';

const getInputRequired = (name: string) =>
  getInput(name, {
    required: true,
  });

(async () => {
  const version = getInputRequired('version');
  const releaseBranch = getInputRequired('release-branch');
  const buildCommand = getMultilineInput('build-command', { required: true });
  const directory = getInputRequired('directory');
  const token = getInputRequired('token');

  const versionInfo = /^v(?<major>\d+).(?<minor>\d+).(?<patch>\d+).*$/.exec(
    version,
  )?.groups as {
    major: string;
    minor: string;
    patch: string;
  } | null;

  if (versionInfo === null) {
    setFailed('Unsupported version format. Use `vx.y.z` style.');
    exit(1);
  }

  const octokit = new Octokit({
    baseUrl: context.apiUrl,
    auth: token,
  });

  const repository = (await octokit.repos.get({ ...context.repo })).data;
  const runInDist = { cwd: resolve(cwd(), directory) };

  await group('Initialising release branch', async () => {
    await exec('git', [
      'config',
      '--global',
      'user.name',
      'github-actions[bot]',
    ]);

    await exec('git', [
      'config',
      '--global',
      'user.email',
      'github-actions[bot]@users.noreply.github.com',
    ]);

    const gitUrl = new URL(repository.clone_url);
    gitUrl.username = 'oauth2';
    gitUrl.password = token;

    await exec('git', [
      'config',
      '--global',
      `url.${gitUrl.toString()}.insteadOf`,
      repository.clone_url,
    ]);

    await mkdir(directory, {
      recursive: true,
    });

    await exec('git', ['init', '-b', releaseBranch], runInDist);
    await exec(
      'git',
      ['remote', 'add', 'origin', repository.clone_url],
      runInDist,
    );

    await exec(
      'git',
      ['pull', '--set-upstream', '--rebase', 'origin', releaseBranch],
      { ...runInDist, ignoreReturnCode: true },
    );
  });

  await group('Running build commands', async () => {
    for (const command of buildCommand) {
      await exec('sh', ['-c', command]);
    }

    await cp('action.yml', resolve(directory, 'action.yml'));
  });

  await group('Committing changes', async () => {
    await exec('git', ['add', '.'], runInDist);
    await exec('git', ['commit', '-m', `feat: Release ${version}`], runInDist);
    await exec('git', ['tag', '-f', `v${versionInfo.major}`], runInDist);
    await exec('git', ['push', '-u', 'origin', releaseBranch], runInDist);
    await exec('git', ['push', '--tags', '-f'], runInDist);
  });

  await group('Creating a release', async () => {
    await octokit.repos.createRelease({
      ...context.repo,
      name: version,
      tag_name: version,
      target_commitish: releaseBranch,
      generate_release_notes: true,
    });
  });
})()
  .then()
  .catch((e) => {
    error(e);
    exit(1);
  });
