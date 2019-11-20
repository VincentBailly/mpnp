const fs = require("fs");
const request = require("request");
const semver = require("semver");
const rimraf = require("rimraf");
const path = require("path");
const tar = require("tar");
const execa = require("execa");

const cacheFolder = "/home/vincent/.mpnpCache";
const installFolder = "/home/vincent/.mpnpInstall";

// When using this package manager, some tool don't declare peer dependencies
// and therefore we need to use the following options to make these work.
// Note that this is supported only from nodejs v12.
// export NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'

const internalPackageLocations = exists(path.join(process.cwd(), "packages")) ? fs.readdirSync("./packages") : [];

const internalPackages = internalPackageLocations.map(loc => {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "packages", loc, "package.json")).toString()).name;
})


function getPackageJson(dir) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json")).toString()
  );
  return packageJson;
}

let lockFile = {};
try {
  lockFile = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "lockFile.json")).toString()
  );
} catch {}

async function extractTar(tarFile, destination) {
  return new Promise(resolve => {
    fs.mkdirSync(destination, {recursive: true});
    fs.createReadStream(tarFile).pipe(tar.x({
      strip: 1,
      cwd: destination,
      sync: true
    })).on("finish", resolve)
  });
    
}

function validatePeerDependencies(dir, parentDependencies) {
  const packageJson = getPackageJson(dir);

  for (let k of Object.keys(packageJson.peerDependencies || {})) {
    if (Object.keys(parentDependencies).indexOf(k) === -1) { throw new Error(`Unfullfilled peer dependency ${k} in ${dir}`); }
    const version = getPackageJson(path.join(dir, "node_modules", k)).version;
    if (version !== parentDependencies[k]) { throw new Error(`Conflicting peer dependencies ${k} : ${version} vs ${parentDependencies[k]}`) }
  }
}

async function setupDependencies(dir, dependencyPath, parentDependencies) {

  const packageJson = getPackageJson(dir);
  const isLocal = dir.indexOf("node_modules") === -1;

  if (isLocal) {
    rimraf.sync(path.join(dir, "node_modules"));
    fs.mkdirSync(path.join(dir, "node_modules"));
  }

  if (!exists(path.join(dir, "node_modules"))) {
    fs.mkdirSync(path.join(dir, "node_modules"));
  }
  if (!exists(path.join(dir, "node_modules", ".bin"))) {
    fs.mkdirSync(path.join(dir, "node_modules", ".bin"));
  }

  const dependencies =
    (isLocal
      ? { ...packageJson.dependencies, ...packageJson.devDependencies }
      : packageJson.dependencies) || [];

  const resolvedDependencies = {};
  resolvedDependencies[packageJson.name] = packageJson.version;
  for (let k of Object.keys(dependencies)) {
    if (internalPackages.indexOf(k) === -1) {
      resolvedDependencies[k] = await resolveVersion(k, dependencies[k]);
    } else {
      resolvedDependencies[k] = 'local';
    }
  }

  for (let k of Object.keys(packageJson.peerDependencies || {})) {
    if (internalPackages.indexOf(k) === -1) {
      if (Object.keys(parentDependencies).indexOf(k) === -1) { throw new Error(`Unfullfilled peer dependency ${k} in ${dir}`); }

      resolvedDependencies[k] = parentDependencies[k]
    } else {
      resolvedDependencies[k] = 'local';
    }
  }


  for (let k of Object.keys(resolvedDependencies)) {

    const version = resolvedDependencies[k];
    const packageKey = `${k}@${version}`;

    // avoid circular dependencies
    if (dependencyPath.indexOf(packageKey) !== -1) { continue }
    if (k === packageJson.name) { continue }

    // console.log("installing ", k, " @ ", version, " path ", dependencyPath);
    const installed = await installPackage(k, version, dir);

    if (!installed) {
      await setupDependencies(path.join(dir, "node_modules", k), [...dependencyPath, packageKey], resolvedDependencies);
    } else {
      validatePeerDependencies(path.join(dir, "node_modules", k), resolvedDependencies);
    }

    const pj = getPackageJson(path.join(dir,"node_modules", k))
    const bins = pj.bin || {};
    if (typeof bins === "string") {
        const binPath = path.join(dir, "node_modules", k, bins);
        fs.chmodSync(binPath, 0o777);
        const newPath = path.join(dir, "node_modules", ".bin", k);
        fs.writeFileSync(newPath, `#!/bin/bash\nnode ${binPath} "$@"`);
        fs.chmodSync(newPath, 0o777);
    } else {
      for (let bin of Object.keys(bins)) {
        const binPath = path.join(dir, "node_modules", k, bins[bin]);
        const newPath = path.join(dir, "node_modules", ".bin", bin);
        fs.writeFileSync(newPath, `#!/bin/bash\nnode ${binPath} "$@"`);
        fs.chmodSync(newPath, 0o777);
      }
    }
    
  };
  if (packageJson.scripts && packageJson.scripts.install) {
    execa.sync("yarn", ["run", "install"], {cwd: dir, stdio: 'inherit'});
  }
  if (packageJson.scripts && packageJson.scripts.postinstall) {
    execa.sync("yarn", ["postinstall"], {cwd: dir, stdio: 'inherit'});
  }
  if (packageJson.scripts && packageJson.scripts.prepare) {
    execa.sync("yarn", ["prepare"], {cwd: dir, stdio: 'inherit'});
  }
}

async function populateCache(packageName, packageVersion) {
  console.log("populating cache for ", packageName, packageVersion)
  return new Promise(resolve => {
    const cache = path.join(cacheFolder,`${packageName}-${packageVersion}.tgz`);
    if (exists(cache)) {
      console.log("cache hit")
      resolve(cache);
      return;
    }

    console.log("cache miss")
    const uri = `https://registry.npmjs.org/${packageName}/-/${packageName}-${packageVersion}.tgz`;
    if (path.join(cache, "..") !== cacheFolder) {
      fs.mkdirSync(path.join(cache, ".."),{recursive: true});
    }
    request(uri).pipe(fs.createWriteStream(cache)).on("close", _ => resolve(cache));
  })
  
}

async function installPackageInCache(packageName, version) {
  const cachePath = path.join(installFolder, `${packageName}@${version}`);
  if (exists(cachePath)) { return Promise.resolve({path:cachePath, installed: true}); };
  return new Promise(async resolve => {
    const cache = await populateCache(packageName, version);
    await extractTar(cache, cachePath);
    resolve({path:cachePath, installed:false});
  });
  
}

async function installPackage(packageName, packageVersion, dir) {
  return new Promise(async resolve => {
    let target = '';
    let alreadyInstalled = false;
    if (internalPackages.indexOf(packageName) !== -1) {
      target = path.join(process.cwd(), "packages", packageName);
    } else {

      const result = await installPackageInCache(packageName, packageVersion);
      target = result.path;
      alreadyInstalled = result.installed;
    }

    if (!exists(path.join(dir, "node_modules", packageName, ".."))) {
      fs.mkdirSync(path.join(dir, "node_modules", packageName, ".."), {recursive: true})
    }

    const newLink = path.join(dir, "node_modules", packageName);
    if (!exists(newLink)) {
      fs.symlinkSync(target, newLink, "junction"); 
    }
    resolve(alreadyInstalled);
  });
}

function resolveVersion(packageName, range) {
  const cacheKey = `${packageName}@${range}`;
  if (lockFile[cacheKey]) { return Promise.resolve(lockFile[cacheKey]); }
  return new Promise(resolve => {
    const uri = `https://registry.npmjs.org/${packageName}`;

    request(uri).on("response", resp => {
      let data = "";
      resp.on("data", chunk => {
        data += chunk;
      });

      // The whole response has been received. Print out the result.
      resp.on("end", () => {
        const versions = Object.keys(JSON.parse(data).versions);
        const winner = versions
          .reverse()
          .find(v => semver.satisfies(v, range));
        lockFile[cacheKey] = winner;
        resolve(winner);
      });
    });
  });
}

function exists(folder) {
  try {
    fs.accessSync(folder)
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await setupDependencies(process.cwd(), [], []);
  for (let loc of internalPackageLocations) {
    await setupDependencies(path.join(process.cwd(), "packages", loc), [], [])
  }
  fs.writeFileSync(path.join(process.cwd(), "lockFile.json"), JSON.stringify(lockFile));
  process.exit(0) ;
  
}


// prevent nodejs to exit while waiting for a promise to resolve.
// this require the code to explicitly exit when done.
setTimeout(_=>{},122342243)
main();
