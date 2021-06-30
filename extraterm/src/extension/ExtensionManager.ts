/*
 * Copyright 2021 Simon Edwards <simon@simonzone.com>
 *
 * This source code is licensed under the MIT license which is detailed in the LICENSE.txt file.
 */
import * as ExtensionApi from "@extraterm/extraterm-extension-api";
import { EventEmitter } from "extraterm-event-emitter";
import * as fs from "fs";
import * as _ from "lodash";
import * as path from "path";
import { BooleanExpressionEvaluator } from "extraterm-boolean-expression-evaluator";

import { Logger, getLogger } from "extraterm-logging";
import { ExtensionMetadata, ExtensionDesiredState, ExtensionCommandContribution, WhenVariables, Category } from "./ExtensionMetadata";
import { parsePackageJsonString } from "./PackageFileParser";
import { Event } from "@extraterm/extraterm-extension-api";
import { log } from "extraterm-logging";
import { ExtensionContextImpl } from "./ExtensionContextImpl";
import { LoadedSessionBackendContribution, LoadedTerminalThemeProviderContribution } from "./ExtensionManagerTypes";
import { ConfigDatabase } from "../config/ConfigDatabase";
import * as SharedMap from "../shared_map/SharedMap";
import { ExtensionManagerIpc } from "./ExtensionManagerIpc";
import * as InternalTypes from "../InternalTypes";
import { CommonExtensionWindowState } from "./CommonExtensionState";
import { CommandMenuEntry } from "../CommandsRegistry";
import { Window } from "../Window";


interface ActiveExtension {
  metadata: ExtensionMetadata;
  publicApi: any;
  contextImpl: ExtensionContextImpl;
  module: any;
}

const allCategories: Category[] = [
  "hyperlink",
  "terminal",
  "viewer",
  "window",
  "application",
  "global",
];


export class ExtensionManager implements InternalTypes.ExtensionManager {
  private _log: Logger = null;

  #configDatabase: ConfigDatabase = null;
  #ipc: ExtensionManagerIpc = null;

  #activeExtensions: ActiveExtension[] = [];
  #desiredStateChangeEventEmitter = new EventEmitter<void>();
  #applicationVersion = "";
  onDesiredStateChanged: Event<void>;
  #extensionPaths: string[] = null;

  #commonExtensionWindowState: CommonExtensionWindowState = {
    // activeTabContent: null,
    activeWindow: null,
    activeTerminal: null,
    // activeTabsWidget: null,
    // activeViewerElement: null,
    // isInputFieldFocus: false,
    activeHyperlinkURL: null,
  };

  constructor(configDatabase: ConfigDatabase, sharedMap: SharedMap.SharedMap, extensionPaths: string[],
      applicationVersion: string) {

    this._log = getLogger("ExtensionManager", this);
    this.#configDatabase = configDatabase;

    this.#ipc = new ExtensionManagerIpc(sharedMap);
    this.#ipc.onEnableExtension((name: string) => {
      this.enableExtension(name);
    });
    this.#ipc.onDisableExtension((name: string) => {
      this.disableExtension(name);
    });

    this.#extensionPaths = extensionPaths;
    this.onDesiredStateChanged = this.#desiredStateChangeEventEmitter.event;
    this.#ipc.setExtensionMetadata(this._scan(this.#extensionPaths));

    // Note: We are passing `applicationVersion` in instead of getting it from `ConfigDatabase` because
    // ConfigDatabase doesn't have a system config ready in time for us to read.
    this.#applicationVersion = applicationVersion;
  }

  startUpExtensions(activeExtensionsConfig: {[name: string]: boolean;}, startByDefault: boolean=true): void {
    const desiredState: ExtensionDesiredState = {};
    for (const extensionInfo of this.#ipc.getExtensionMetadata()) {
      desiredState[extensionInfo.name] = startByDefault;
    }

    // Merge in the explicitly enabled/disabled extensions from the config.
    if (activeExtensionsConfig != null) {
      for (const key of Object.keys(activeExtensionsConfig)) {
        if (this._getExtensionMetadataByName(key) != null) {
          desiredState[key] = activeExtensionsConfig[key];
        }
      }
    }

    for (const extensionName of Object.keys(desiredState)) {
      if (desiredState[extensionName]) {
        this._startExtension(this._getExtensionMetadataByName(extensionName));
      }
    }

    this.#ipc.setDesiredState(desiredState);
  }

  private _scan(extensionPaths: string[]): ExtensionMetadata[] {
    return _.flatten(extensionPaths.map(p => this._scanPath(p)));
  }

  private _scanPath(extensionPath: string): ExtensionMetadata[] {
    this._log.info(`Scanning '${extensionPath}' for extensions.`);
    if (fs.existsSync(extensionPath)) {
      const result: ExtensionMetadata[] = [];
      const contents = fs.readdirSync(extensionPath);
      for (const item of contents) {
        const packageJsonPath = path.join(extensionPath, item, "package.json");

        if (fs.existsSync(packageJsonPath)) {
          const extensionInfoPath = path.join(extensionPath, item);
          const extensionInfo = this._loadPackageJson(extensionInfoPath);
          if (extensionInfo !== null) {
            result.push(extensionInfo);
            this._log.info(`Read extension metadata from '${extensionInfoPath}'.`);
          }
        } else {
          this._log.warn(`Unable to read ${packageJsonPath}, skipping`);
        }
      }
      return result;

    } else {
      this._log.warn(`Extension path ${extensionPath} doesn't exist.`);
      return [];
    }
  }

  private _loadPackageJson(extensionPath: string): ExtensionMetadata {
    const packageJsonPath = path.join(extensionPath, "package.json");
    const packageJsonString = fs.readFileSync(packageJsonPath, "utf8");
    try {
      const result = parsePackageJsonString(packageJsonString, extensionPath);

      const jsonTree = JSON.parse(packageJsonString);
      const readmePath = this._getExtensionReadmePath(jsonTree, extensionPath);

      return {...result, readmePath };
    } catch(ex) {
      this._log.warn(`An error occurred while processing '${packageJsonPath}': ` + ex);
      return null;
    }
  }

  private _getExtensionReadmePath(packageJsonTree: any, extensionPath: string): string {
    if (packageJsonTree.extratermReadme != null) {
      return path.join(extensionPath, packageJsonTree.extratermReadme);
    } else {
      const entries = fs.readdirSync(extensionPath);
      for (const entry of entries) {
        if (entry.toLowerCase().startsWith("readme.")) {
          return path.join(extensionPath, entry);
        }
      }
      return null;
    }
  }

  private _getExtensionMetadataByName(name: string): ExtensionMetadata {
    for (const extensionInfo of this.#ipc.getExtensionMetadata()) {
      if (extensionInfo.name === name) {
        return extensionInfo;
      }
    }
    return null;
  }

  private _startExtension(metadata: ExtensionMetadata): ActiveExtension {
    let module = null;
    let publicApi = null;
    let contextImpl: ExtensionContextImpl = null;

    this._log.info(`Starting extension '${metadata.name}'`);

    contextImpl = new ExtensionContextImpl(this, metadata, this.#configDatabase, null, this.#applicationVersion);
    if (metadata.main != null) {
      module = this._loadExtensionModule(metadata);
      if (module == null) {
        return null;
      }
      try {
        publicApi = (<ExtensionApi.ExtensionModule> module).activate(contextImpl);
      } catch(ex) {
        this._log.warn(`Exception occurred while activating extension ${metadata.name}. ${ex}`);
        return null;
      }
    }
    const activeExtension: ActiveExtension = {metadata, publicApi, contextImpl, module};
    this.#activeExtensions.push(activeExtension);
    return activeExtension;
  }

  private _loadExtensionModule(extension: ExtensionMetadata): any {
    const mainJsPath = path.join(extension.path, extension.main);
    try {
      const module = require(mainJsPath);
      return module;
    } catch(ex) {
      this._log.warn(`Unable to load ${mainJsPath}. ${ex}`);
      return null;
    }
  }

  private _stopExtension(activeExtension: ActiveExtension): void {
    if (activeExtension.module != null) {
      try {
        const extratermModule = (<ExtensionApi.ExtensionModule> activeExtension.module);
        if (extratermModule.deactivate != null) {
          extratermModule.deactivate(true);
        }
      } catch(ex) {
        this._log.warn(`Exception occurred while deactivating extension ${activeExtension.metadata.name}. ${ex}`);
      }
    }

    activeExtension.contextImpl.dispose();
    this.#activeExtensions = this.#activeExtensions.filter(ex => ex !== activeExtension);
  }

  getExtensionMetadata(): ExtensionMetadata[] {
    return this.#ipc.getExtensionMetadata();
  }

  getActiveExtensionMetadata(): ExtensionMetadata[] {
    return this.#activeExtensions.map(ae => ae.metadata);
  }

  getExtensionContextByName(name: string): InternalTypes.InternalExtensionContext {
    const extension = this._getActiveExtension(name);
    return extension != null ? extension.contextImpl : null;
  }

  enableExtension(name: string): void {
    const metadata = this._getExtensionMetadataByName(name);
    if (metadata == null) {
      this._log.warn(`Unable to find extensions metadata for name '${name}'.`);
      return;
    }

    const activeExtension = this._getActiveExtension(name);
    if (activeExtension != null) {
      this._log.warn(`Tried to enable active extension '${name}'.`);
      return;
    }

    this._startExtension(metadata);

    const generalConfig = this.#configDatabase.getGeneralConfigCopy();
    generalConfig.activeExtensions[metadata.name] = true;
    this.#configDatabase.setGeneralConfig(generalConfig);

    const desiredState = {...this.#ipc.getDesiredState()};
    desiredState[metadata.name] = true;
    this.#ipc.setDesiredState(desiredState);

    this.#desiredStateChangeEventEmitter.fire();
  }

  private _getActiveExtension(name: string): ActiveExtension {
    for (const extension of this.#activeExtensions) {
      if (extension.metadata.name === name) {
        return extension;
      }
    }
    return null;
  }

  disableExtension(name: string): void {
    const metadata = this._getExtensionMetadataByName(name);
    if (metadata == null) {
      this._log.warn(`Unable to find extensions metadata for name '${name}'.`);
      return;
    }

    const activeExtension = this._getActiveExtension(name);
    if (activeExtension == null) {
      this._log.warn(`Tried to disable inactive extension '${name}'.`);
      return;
    }

    this._stopExtension(activeExtension);

    const desiredState = {...this.#ipc.getDesiredState()};
    desiredState[metadata.name] = false;
    this.#ipc.setDesiredState(desiredState);

    const generalConfig = this.#configDatabase.getGeneralConfigCopy();
    generalConfig.activeExtensions[metadata.name] = false;
    this.#configDatabase.setGeneralConfig(generalConfig);

    this.#desiredStateChangeEventEmitter.fire();
  }

  getDesiredState(): ExtensionDesiredState {
    return this.#ipc.getDesiredState();
  }

  private _getActiveBackendExtensions(): ActiveExtension[] {
    return this.#activeExtensions.filter(ae => ae.contextImpl != null);
  }

  getSessionBackendContributions(): LoadedSessionBackendContribution[] {
    return _.flatten(this._getActiveBackendExtensions().map(
      ae => ae.contextImpl._internalBackend._sessionBackends));
  }

  getSessionBackend(type: string): ExtensionApi.SessionBackend {
    for (const extension of this._getActiveBackendExtensions()) {
      for (const backend of extension.contextImpl._internalBackend._sessionBackends) {
        if (backend.sessionBackendMetadata.type === type) {
          return backend.sessionBackend;
        }
      }
    }
    return null;
  }

  getTerminalThemeProviderContributions(): LoadedTerminalThemeProviderContribution[] {
    return _.flatten(this._getActiveBackendExtensions().map(
      ae => ae.contextImpl._internalBackend._terminalThemeProviders));
  }

  hasCommand(command: string): boolean {
    return this._getCommand(command) != null;
  }

  private _getExtensionNameFromCommand(command: string): string {
    const parts = command.split(":");
    if (parts.length !== 2) {
      this._log.warn(`Command '${command}' does have the right form. (Wrong numer of colons.)`);
      return null;
    }

    let extensionName = parts[0];
    if (extensionName === "extraterm") {
      extensionName = "internal-commands";
    }
    return extensionName;
  }

  private _getCommand(command: string) {
    const extensionName = this._getExtensionNameFromCommand(command);
    const ext = this._getActiveExtension(extensionName);
    if (ext == null) {
      return null;
    }
    return ext.contextImpl.commands.getCommandFunction(command);
  }

  setActiveWindow(window: Window): void {
    this.#commonExtensionWindowState.activeWindow = window;
  }

  /**
   * Execute a function with a different temporary extension context.
   */
  private _executeFuncWithExtensionWindowState<R>(tempState: CommonExtensionWindowState, func: () => R): R {
    const oldState = this.copyExtensionWindowState();
    this._setExtensionWindowState(tempState);
    const result = func();
    this._setExtensionWindowState(oldState);
    return result;
  }

  copyExtensionWindowState(): CommonExtensionWindowState {
    return { ...this.#commonExtensionWindowState };
  }

  executeCommand(command: string, args?: any): any {
    let commandName = command;
    let argsString: string = null;

    const qIndex = command.indexOf("?");
    if (qIndex !== -1) {
      commandName = command.slice(0, qIndex);
      argsString = command.slice(qIndex+1);
    }

    const parts = commandName.split(":");
    if (parts.length !== 2) {
      throw new Error(`Command '${command}' does have the right form. (Wrong numer of colons.)`);
    }

    let extensionName = parts[0];
    if (extensionName === "extraterm") {
      extensionName = "internal-commands";
    }

    if (args === undefined) {
      if (argsString != null) {
        args = JSON.parse(decodeURIComponent(argsString));
      } else {
        args = {};
      }
    }

    for (const ext of this.#activeExtensions) {
      if (ext.metadata.name === extensionName) {
        const commandFunc = ext.contextImpl.commands.getCommandFunction(commandName);
        if (commandFunc == null) {
          throw new Error(`Unable to find command '${commandName}' in extension '${extensionName}'.`);
        }
        return this._runCommandFunc(commandName, commandFunc, args);
      }
    }

    throw new Error(`Unable to find extension with name '${extensionName}' for command '${commandName}'.`);
  }

  private _runCommandFunc(name: string, commandFunc: (args: any) => any, args: any): any {
    try {
      return commandFunc(args);
    } catch(ex) {
      this._log.warn(`Command '${name}' threw an exception.`, ex);
      return ex;
    }
  }

  private _setExtensionWindowState(newState: CommonExtensionWindowState): void {
    for (const key in newState) {
      this.#commonExtensionWindowState[key] = newState[key];
    }
  }

  queryCommands(options: InternalTypes.CommandQueryOptions): ExtensionCommandContribution[] {
    return this.queryCommandsWithExtensionWindowState(options, this.#commonExtensionWindowState);
  }

  queryCommandsWithExtensionWindowState(options: InternalTypes.CommandQueryOptions, context: CommonExtensionWindowState): ExtensionCommandContribution[] {
    const truePredicate = (command: CommandMenuEntry): boolean => true;

    let commandPalettePredicate = truePredicate;
    if (options.commandPalette != null) {
      const commandPalette = options.commandPalette;
      commandPalettePredicate = commandEntry => commandEntry.commandPalette === commandPalette;
    }

    let contextMenuPredicate = truePredicate;
    if (options.contextMenu != null) {
      const contextMenu = options.contextMenu;
      contextMenuPredicate = command => command.contextMenu === contextMenu;
    }

    let newTerminalMenuPredicate = truePredicate;
    if (options.newTerminalMenu != null) {
      const newTerminalMenu = options.newTerminalMenu;
      newTerminalMenuPredicate = commandEntry => commandEntry.newTerminal === newTerminalMenu;
    }

    let terminalTabMenuPredicate = truePredicate;
    if (options.terminalTitleMenu != null) {
      const terminalTabMenu = options.terminalTitleMenu;
      terminalTabMenuPredicate = commandEntry => commandEntry.terminalTab === terminalTabMenu;
    }

    let windowMenuPredicate = truePredicate;
    if (options.windowMenu != null) {
      const windowMenu = options.windowMenu;
      windowMenuPredicate = commandEntry => commandEntry.windowMenu === windowMenu;
    }

    let categoryPredicate = truePredicate;
    if (options.categories != null) {
      const categories = options.categories;
      categoryPredicate = commandEntry => categories.indexOf(commandEntry.commandContribution.category) !== -1;
    }

    let commandPredicate = truePredicate;
    if (options.commands != null) {
      const commands = options.commands;
      commandPredicate = commandEntry => {
        return commands.indexOf(commandEntry.commandContribution.command) !== -1;
      };
    }

    const whenPredicate = options.when ? this._createWhenPredicate(context) : truePredicate;

    const entries: ExtensionCommandContribution[] = [];
    for (const activeExtension  of this.#activeExtensions) {
      for (const [command, commandEntryList] of activeExtension.contextImpl.commands._commandToMenuEntryMap) {
        for (const commandEntry of commandEntryList) {
          if (commandPredicate(commandEntry) && commandPalettePredicate(commandEntry) &&
              contextMenuPredicate(commandEntry) && newTerminalMenuPredicate(commandEntry) &&
              terminalTabMenuPredicate(commandEntry) && windowMenuPredicate(commandEntry) &&
              categoryPredicate(commandEntry) &&
              whenPredicate(commandEntry)) {

            const customizer = activeExtension.contextImpl.commands.getFunctionCustomizer(
                                commandEntry.commandContribution.command);
            if (customizer != null) {
              this._executeFuncWithExtensionWindowState(context, () => {
                entries.push( {...commandEntry.commandContribution, ...customizer() });
              });
            } else {
              entries.push(commandEntry.commandContribution);
            }
          }
        }
      }
    }
    this._sortCommandsInPlace(entries);
    return entries;
  }

  private _createWhenPredicate(state: CommonExtensionWindowState): (ecc: CommandMenuEntry) => boolean {
    const variables = this._createWhenVariables(state);
    const bee = new BooleanExpressionEvaluator(variables);
    return (ecc: CommandMenuEntry): boolean => {
      if (ecc.commandContribution.when === "") {
        return true;
      }
      return bee.evaluate(ecc.commandContribution.when);
    };
  }

  private _createWhenVariables(state: CommonExtensionWindowState): WhenVariables {
    const whenVariables: WhenVariables = {
      true: true,
      false: false,
      terminalFocus: false,
      viewerFocus: false,
      isHyperlink: false,
      hyperlinkURL: null,
      hyperlinkProtocol: null,
      hyperlinkDomain: null,
      hyperlinkFileExtension: null,
    };

    if (state.activeTerminal != null) {
      whenVariables.terminalFocus = true;
    } else {
      // if (state.activeViewerElement) {
      //   whenVariables.viewerFocus = true;
      // }
    }

    if (state.activeHyperlinkURL != null) {
      whenVariables.isHyperlink = true;
      whenVariables.hyperlinkURL = state.activeHyperlinkURL;
      try {
        const url = new URL(state.activeHyperlinkURL);
        whenVariables.hyperlinkProtocol = url.protocol;
        whenVariables.hyperlinkDomain = url.hostname;
        whenVariables.hyperlinkFileExtension = this._getExtensionFromPath(url.pathname);
      } catch (e) {
        whenVariables.hyperlinkProtocol = "";
        whenVariables.hyperlinkDomain = "";
        whenVariables.hyperlinkFileExtension = this._getExtensionFromPath(state.activeHyperlinkURL);
      }
    }
    return whenVariables;
  }

  private _getExtensionFromPath(path: string): string {
    const pathParts = path.split("/");
    const lastPathPart = pathParts[pathParts.length -1];
    if (lastPathPart.includes(".")) {
      return lastPathPart.substr(lastPathPart.lastIndexOf(".") + 1);
    }
    return "";
  }

  private _sortCommandsInPlace(entries: ExtensionCommandContribution[]): void {
    entries.sort(this._sortCompareFunc);
  }

  private _sortCompareFunc(a: ExtensionCommandContribution, b: ExtensionCommandContribution): number {
    const aIndex = allCategories.indexOf(a.category);
    const bIndex = allCategories.indexOf(b.category);
    if (aIndex !== bIndex) {
      return aIndex < bIndex ? -1 : 1;
    }

    if (a.order !== b.order) {
      return a.order < b.order ? -1 : 1;
    }

    if (a.title !== b.title) {
      return a.title < b.title ? -1 : 1;
    }
    return 0;
  }


}