/**********************************************************************
 * Copyright (C) 2023 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/
import * as path from 'node:path';
import { existsSync, promises } from 'node:fs';
import * as extensionApi from '@podman-desktop/api';
import type { Detect } from './detect';
import type { ComposeGitHubReleases } from './compose-github-releases';
import type { OS } from './os';
import { platform, arch } from 'node:os';
import type { ComposeWrapperGenerator } from './compose-wrapper-generator';

export class ComposeExtension {
  public static readonly COMPOSE_INSTALL_COMMAND = 'compose.install';
  public static readonly COMPOSE_CHECKS_COMMAND = 'compose.checks';

  public static readonly ICON_CHECK = 'fa fa-check';
  public static readonly ICON_DOWNLOAD = 'fa fa-download';
  public static readonly ICON_WARNING = 'fa fa-exclamation-triangle';

  private statusBarItem: extensionApi.StatusBarItem | undefined;

  protected currentInformation: string | undefined;

  constructor(
    private readonly extensionContext: extensionApi.ExtensionContext,
    private readonly detect: Detect,
    private readonly composeGitHubReleases: ComposeGitHubReleases,
    private readonly os: OS,
    private podmanComposeGenerator: ComposeWrapperGenerator,
  ) {}

  async runChecks(firstCheck: boolean): Promise<void> {
    this.currentInformation = undefined;

    // reset status bar information
    const statusBarChangesToApply = {
      iconClass: '',
      tooltip: '',
      command: ComposeExtension.COMPOSE_CHECKS_COMMAND,
    };

    // check for docker-compose
    const dockerComposeInstalled = await this.detect.checkForDockerCompose();
    if (dockerComposeInstalled) {
      // check if we have compatibility mode or docker setup
      const compatibilityModeSetup = await this.detect.checkDefaultSocketIsAlive();
      if (compatibilityModeSetup) {
        // it's installed so we're good
        statusBarChangesToApply.iconClass = ComposeExtension.ICON_CHECK;
        statusBarChangesToApply.tooltip = 'Compose is installed and DOCKER_HOST is reachable';
      } else {
        // grab the current connection to container engine
        const connections = extensionApi.provider.getContainerConnections();
        const startedConnections = connections.filter(
          providerConnection => providerConnection.connection.status() === 'started',
        );
        if (startedConnections.length === 0) {
          statusBarChangesToApply.iconClass = ComposeExtension.ICON_WARNING;
          statusBarChangesToApply.tooltip =
            'No running container engine. Unable to write a compose wrapper script that will set DOCKER_HOST in that case. Please start a container engine first.';
        } else {
          // need to write the wrapper for docker-compose and use the name 'compose'
          // add wrapper script
          await this.addComposeWrapper(startedConnections[0]);

          // check if the extension bin folder is in the PATH
          const extensionBinFolderInPath = await this.detect.checkStoragePath();
          if (!extensionBinFolderInPath) {
            // not there, ask the user to setup the PATH
            statusBarChangesToApply.iconClass = ComposeExtension.ICON_WARNING;
            statusBarChangesToApply.tooltip = `${this.detect.getSocketPath()} is not enabled. Need to use wrapper script`;
            this.currentInformation = `Please add the compose wrapper bin folder to your PATH environment variable. Value is ${path.resolve(
              this.extensionContext.storagePath,
              'bin',
            )}. The script ${path.resolve(
              this.extensionContext.storagePath,
              'bin',
              'compose',
            )} will setup for you the DOCKER_HOST environment variable.`;
          } else {
            // it's installed so we're good
            statusBarChangesToApply.iconClass = ComposeExtension.ICON_CHECK;
            statusBarChangesToApply.tooltip = `Compose is installed and usable with ${path.resolve(
              this.extensionContext.storagePath,
              'bin',
              'compose',
            )}`;
          }
        }
      }
    } else {
      // not installed, propose to install it
      statusBarChangesToApply.iconClass = ComposeExtension.ICON_DOWNLOAD;
      statusBarChangesToApply.tooltip = 'Install Compose';
      statusBarChangesToApply.command = ComposeExtension.COMPOSE_INSTALL_COMMAND;
    }
    // apply status bar changes
    if (this.statusBarItem) {
      this.statusBarItem.iconClass = statusBarChangesToApply.iconClass;
      this.statusBarItem.tooltip = statusBarChangesToApply.tooltip;
      this.statusBarItem.command = statusBarChangesToApply.command;
    }

    this.notifyOnChecks(firstCheck);
  }

  protected notifyOnChecks(firstCheck: boolean): void {
    if (this.currentInformation && !firstCheck) {
      this.showCurrentInformation();
    }
  }

  async activate(): Promise<void> {
    if (!this.statusBarItem) {
      // create a status bar item
      this.statusBarItem = extensionApi.window.createStatusBarItem(extensionApi.StatusBarAlignLeft, 100);
      this.statusBarItem.text = 'Compose';
      this.statusBarItem.command = ComposeExtension.COMPOSE_CHECKS_COMMAND;
      this.statusBarItem.show();
      this.extensionContext.subscriptions.push(this.statusBarItem);
    }

    // run init checks
    await this.runChecks(true);

    const disposableInstall = extensionApi.commands.registerCommand(ComposeExtension.COMPOSE_INSTALL_COMMAND, () =>
      this.installDockerCompose(),
    );
    const disposableShowInfo = extensionApi.commands.registerCommand(ComposeExtension.COMPOSE_CHECKS_COMMAND, () =>
      this.runChecks(false),
    );
    this.extensionContext.subscriptions.push(disposableInstall, disposableShowInfo);
  }

  async installDockerCompose(): Promise<void> {
    // grab latest assets metadata
    const lastReleasesMetadata = await this.composeGitHubReleases.grabLatestsReleasesMetadata();

    // display a choice to the user with quickpick
    let selectedRelease = await extensionApi.window.showQuickPick(lastReleasesMetadata, {
      placeHolder: 'Select docker compose version to install',
    });
    if (!selectedRelease) {
      // user cancelled
      selectedRelease = lastReleasesMetadata[0];
    }

    // get asset id
    const assetId = await this.composeGitHubReleases.getReleaseAssetId(selectedRelease.id, platform(), arch());

    // get storage data
    const storageData = await this.extensionContext.storagePath;
    const storageBinFolder = path.resolve(storageData, 'bin');
    if (!existsSync(storageBinFolder)) {
      // create the folder
      await promises.mkdir(storageBinFolder, { recursive: true });
    }

    // append file extension
    let fileExtension = '';
    if (this.os.isWindows()) {
      fileExtension = '.exe';
    }

    // path
    const dockerComposeDownloadLocation = path.resolve(storageBinFolder, `docker-compose${fileExtension}`);

    // download the asset
    await this.composeGitHubReleases.downloadReleaseAsset(assetId, dockerComposeDownloadLocation);

    // make it executable
    await this.makeExecutable(dockerComposeDownloadLocation);

    extensionApi.window.showInformationMessage(`Docker Compose ${selectedRelease.label} installed`);

    // update checks
    this.runChecks(false);
  }

  // add script that is redirecting to docker-compose and configuring the socket using DOCKER_HOST
  async addComposeWrapper(connection: extensionApi.ProviderContainerConnection): Promise<void> {
    // get storage data
    const storageData = await this.extensionContext.storagePath;
    const storageBinFolder = path.resolve(storageData, 'bin');

    if (!existsSync(storageBinFolder)) {
      // create the folder
      await promises.mkdir(storageBinFolder, { recursive: true });
    }

    // append file extension
    let fileExtension = '';
    if (this.os.isWindows()) {
      fileExtension = '.bat';
    }

    // create the script file
    const composeWrapperScript = path.resolve(storageBinFolder, `compose${fileExtension}`);

    await this.podmanComposeGenerator.generate(connection, composeWrapperScript);

    // make it executable
    await this.makeExecutable(composeWrapperScript);
  }

  showCurrentInformation(): void {
    if (this.currentInformation) {
      extensionApi.window.showInformationMessage(this.currentInformation);
    }
  }

  async makeExecutable(filePath: string): Promise<void> {
    if (this.os.isLinux() || this.os.isMac()) {
      await promises.chmod(filePath, 0o755);
    }
  }

  async deactivate(): Promise<void> {
    console.log('stopping compose extension');
  }
}
