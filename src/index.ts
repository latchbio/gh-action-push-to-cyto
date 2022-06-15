import * as path from "node:path";
import * as fs from "node:fs/promises";

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as artifact from "@actions/artifact";
import * as tc from "@actions/tool-cache";

const run = async () => {
  try {
    core.debug("Creating artifact client");
    const artifactClient = artifact.create();

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

    const setupKustomize = async () => {
      const url = `https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${kustomizeVersion}/kustomize_v${kustomizeVersion}_linux_amd64.tar.gz`;
      core.debug(`Fetching customize from ${url}`);
      const kustomizeTar = await tc.downloadTool(url);
      core.debug(`Extracting ${kustomizeTar}`);
      const kustomizeFolder = await tc.extractTar(kustomizeTar);
      core.debug(`Caching ${kustomizeFolder}/kustomize`);
      const kustomizeCachedPath = await tc.cacheFile(
        kustomizeFolder,
        "kustomize",
        "kustomize",
        kustomizeVersion
      );
      const kustomizeBinary = path.join(kustomizeCachedPath, "kustomize");
      core.debug(`Making ${kustomizeBinary} executable`);
      await exec.exec("chmod", ["u+x", kustomizeBinary]);
      return kustomizeBinary;
    };

    const getVersion = async () => {
      core.debug(`Fetching version artifact "${version}"`);
      const path = (await artifactClient.downloadArtifact(version))
        .downloadPath;
      core.debug(`Reading version artifact from ${path}`);
      return await fs.readFile(path);
    };

    const downloadCytoplasm = async () => {
      const url = `https://${token}:x-oauth-basic@github.com/${repo}.git`;
      core.debug(`Cloning cytoplasm from ${url.replace(token, "TOKEN")}`);
      await exec.exec("git", ["clone", url]);
    };

    const [kustomizeBinary, serviceVersion, _] = await Promise.all([
      setupKustomize(),
      getVersion(),
      downloadCytoplasm(),
    ]);

    const repoNameStartIdx = repo.lastIndexOf("/");
    const repoPath = repo.slice(repoNameStartIdx + 1);
    core.debug(`Working in ${repoPath}`);

    const overlayPath = `${repoPath}/kustomize/overlays/${overlayName}`;
    core.info(`Setting ${serviceName}=${serviceVersion} in ${overlayPath}`);
    await exec.exec(
      kustomizeBinary,
      ["edit", "set", "image", `${serviceName}=*:${serviceVersion}`],
      {
        cwd: overlayPath,
      }
    );
    core.info(`Comitting`);
    await exec.exec(
      "git",
      [
        "commit",
        "--author",
        `${commitName} <${commitEmail}>`,
        "--all",
        "--message",
        `${serviceName}=${serviceVersion}`,
      ],
      {
        cwd: repoPath,
      }
    );
    core.info(`Pushing`);
    await exec.exec("git", ["push"], {
      cwd: repoPath,
    });
  } catch (error) {
    core.setFailed(error.message);
  }
};

run();
