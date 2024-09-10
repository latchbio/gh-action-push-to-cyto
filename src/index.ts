import * as path from "node:path";
import * as fs from "node:fs/promises";

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { DefaultArtifactClient } from "@actions/artifact";
import * as tc from "@actions/tool-cache";

const run = async () => {
  try {
    core.debug("Creating artifact client");
    const artifactClient = new DefaultArtifactClient()

    core.debug("Loading inputs");
    const token = core.getInput("token");
    const serviceName = core.getInput("service-name");
    const overlayName = core.getInput("overlay-name");

    const repo = core.getInput("repo");
    const version = core.getInput("version");
    const kustomizeVersion = core.getInput("kustomize-version");

    const commitEmail = core.getInput("commit-email");
    const commitName = core.getInput("commit-name");
    core.info(
      [
        `Upgrading ${serviceName} in ${overlayName}`,
        `  Version artifact: ${version}`,
        `  Token: ${"*".repeat(token.length)}`,
        "",
        `  Cytoplasm: ${repo}`,
        `  Kustomize version: ${kustomizeVersion}`,
        `  Committing as: "${commitName} <${commitEmail}>"`,
      ].join("\n")
    );

    const configureGit = async () => {
      core.debug(`Setting git user email`);
      await exec.exec("git", ["config", "--global", "user.email", commitEmail]);
      core.debug(`Setting git user name`);
      await exec.exec("git", ["config", "--global", "user.name", commitName]);
    };

    const setupKustomize = async () => {
      const url = `https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${kustomizeVersion}/kustomize_v${kustomizeVersion}_linux_amd64.tar.gz`;
      core.debug(`Fetching kustomize from ${url}`);
      const kustomizeTar = await tc.downloadTool(url);
      core.debug(`Extracting ${kustomizeTar}`);
      const kustomizeFolder = await tc.extractTar(kustomizeTar);
      const kustomizeBinary = path.join(kustomizeFolder, "kustomize");
      core.debug(`Caching ${kustomizeBinary}`);
      const kustomizeCachedPath = await tc.cacheFile(
        kustomizeBinary,
        "kustomize",
        "kustomize",
        kustomizeVersion
      );
      const kustomizeCachedBinary = path.join(kustomizeCachedPath, "kustomize");
      core.debug(`Making ${kustomizeCachedBinary} executable`);
      await exec.exec("chmod", ["u+x", kustomizeCachedBinary]);
      return kustomizeCachedBinary;
    };

    const getVersion = async () => {
      core.debug(`Fetching version artifact "${version}"`);
      const artifact = (await artifactClient.getArtifact(version)).artifact
      const artifactId = artifact.id
      const downloadPath = (await artifactClient.downloadArtifact(artifactId)).downloadPath
      if (downloadPath == null)
        throw new Error("Download path for artifact ${version} is null");

      const p = path.join( downloadPath, "version.txt");
      core.debug(`Reading version artifact from ${p}`);
      return (await fs.readFile(p, { encoding: "utf-8" })).trim();
    };

    const downloadCytoplasm = async () => {
      const url = `https://${token}:x-oauth-basic@github.com/${repo}.git`;
      core.debug(`Cloning cytoplasm from ${url.replace(token, "TOKEN")}`);
      await exec.exec("git", ["clone", url]);
    };

    const [kustomizeBinary, serviceVersion, _, _2] = await Promise.all([
      setupKustomize(),
      getVersion(),
      downloadCytoplasm(),
      configureGit(),
    ]);

    const repoNameStartIdx = repo.lastIndexOf("/");
    const repoPath = repo.slice(repoNameStartIdx + 1);
    core.debug(`Working in ${repoPath}`);

    let attempts = 0;
    while (true) {
      const overlayPath = `${repoPath}/kustomize/overlays/${overlayName}`;
      core.info(`Setting ${serviceName}=${serviceVersion} in ${overlayPath}`);
      await exec.exec(
        kustomizeBinary,
        ["edit", "set", "image", `${serviceName}=*:${serviceVersion}`],
        {
          cwd: overlayPath,
        }
      );

      const diffExitCode = await exec.exec("git", ["diff", "--exit-code"], {
        cwd: repoPath,
        ignoreReturnCode: true,
      });
      if (diffExitCode == 0) {
        core.info("Service is already up-to-date");
        return;
      }

      core.info(`Comitting`);
      await exec.exec(
        "git",
        ["commit", "--all", "--message", `${serviceName}=${serviceVersion}`],
        {
          cwd: repoPath,
        }
      );

      core.info(`Pushing`);
      const res = await exec.exec("git", ["push"], {
        cwd: repoPath,
        ignoreReturnCode: true,
      });
      if (res === 0) break;

      attempts += 1;
      if (attempts > 3) {
        core.setFailed(
          `Failed to push to cytoplasm after ${attempts} attempts`
        );
        return;
      }
      core.info("Failed to push, retrying");
      core.debug("Resetting");
      await exec.exec("git", ["reset", "--hard", "origin/main"], {
        cwd: repoPath,
      });
      core.debug("Pulling");
      await exec.exec("git", ["pull"], {
        cwd: repoPath,
      });
    }
  } catch (error) {
    core.setFailed(error);
  }
};

run();
