'use strict';
const _ = require('lodash');
const dd = require('dedent');
const fs = require('fs');
const joi = require('joi');

const actions = require('@arangodb/actions');
const ArangoError = require('@arangodb').ArangoError;
const errors = require('@arangodb').errors;
const jsonml2xml = require('@arangodb/util').jsonml2xml;
const swaggerJson = require('@arangodb/foxx/legacy/swagger').swaggerJson;
const FoxxManager = require('@arangodb/foxx/manager');
const FoxxService = require('@arangodb/foxx/service');
const createRouter = require('@arangodb/foxx/router');
const reporters = Object.keys(require('@arangodb/mocha').reporters);
const schemas = require('./schemas');

const router = createRouter();
module.context.registerType('multipart/form-data', require('./multipart'));
module.context.use(router);

const LDJSON = 'application/x-ldjson';

const legacyErrors = new Map([
  [errors.ERROR_SERVICE_INVALID_NAME.code, errors.ERROR_SERVICE_SOURCE_NOT_FOUND.code],
  [errors.ERROR_SERVICE_INVALID_MOUNT.code, errors.ERROR_INVALID_MOUNTPOINT.code],
  [errors.ERROR_SERVICE_DOWNLOAD_FAILED.code, errors.ERROR_SERVICE_SOURCE_ERROR.code],
  [errors.ERROR_SERVICE_UPLOAD_FAILED.code, errors.ERROR_SERVICE_SOURCE_ERROR.code]
]);

const serviceToJson = (service) => (
  {
    mount: service.mount,
    path: service.basePath,
    name: service.manifest.name,
    version: service.manifest.version,
    development: service.isDevelopment,
    legacy: service.legacy,
    manifest: service.manifest,
    checksum: service.checksum,
    options: _.pick(service.options, ['configuration', 'dependencies'])
  }
);

function prepareServiceRequestBody (req, res, next) {
  if (req.body instanceof Buffer) {
    req.body = {source: req.body};
  }
  try {
    if (req.body.dependencies) {
      req.body.dependencies = JSON.parse(req.body.dependencies);
    }
    if (req.body.configuration) {
      req.body.configuration = JSON.parse(req.body.configuration);
    }
  } catch (e) {
    throw new ArangoError({
      errorNum: errors.ERROR_SERVICE_OPTIONS_MALFORMED.code,
      errorMessage: dd`
        ${errors.ERROR_SERVICE_OPTIONS_MALFORMED.message}
        Details: ${e.message}
      `
    }, {cause: e});
  }
  next();
}

router.use((req, res, next) => {
  try {
    next();
  } catch (e) {
    if (e.isArangoError) {
      const errorNum = legacyErrors.get(e.errorNum) || e.errorNum;
      const status = actions.arangoErrorToHttpCode(errorNum);
      res.throw(status, e.errorMessage, {errorNum, cause: e});
    }
    throw e;
  }
});

router.get((req, res) => {
  res.json(
    FoxxManager.installedServices()
    .map((service) => (
      {
        mount: service.mount,
        name: service.manifest.name,
        version: service.manifest.version,
        provides: service.manifest.provides || {},
        development: service.isDevelopment,
        legacy: service.legacy
      }
    ))
  );
})
.response(200, joi.array().items(schemas.shortInfo).required());

if (FoxxManager.isFoxxmaster()) {
  router.post(prepareServiceRequestBody, (req, res) => {
    const mount = req.queryParams.mount;
    FoxxManager.install(req.body.source, mount, _.omit(req.queryParams, ['mount', 'development']));
    if (req.body.configuration) {
      FoxxManager.setConfiguration(mount, {configuration: req.body.configuration, replace: true});
    }
    if (req.body.dependencies) {
      FoxxManager.setDependencies(mount, {dependencies: req.body.dependencies, replace: true});
    }
    if (req.queryParams.development) {
      FoxxManager.development(mount);
    }
    const service = FoxxManager.lookupService(mount);
    res.json(serviceToJson(service));
  })
  .body(schemas.service, ['application/javascript', 'application/zip', 'multipart/form-data', 'application/json'])
  .queryParam('mount', schemas.mount)
  .queryParam('development', schemas.flag.default(false))
  .queryParam('setup', schemas.flag.default(true))
  .queryParam('legacy', schemas.flag.default(false))
  .response(201, schemas.fullInfo);
} else {
  router.post(FoxxManager.proxyToFoxxmaster);
}

const instanceRouter = createRouter();
instanceRouter.use((req, res, next) => {
  const mount = req.queryParams.mount;
  try {
    req.service = FoxxManager.lookupService(mount);
  } catch (e) {
    res.throw(400, `No service installed at mount path "${mount}".`, e);
  }
  next();
})
.queryParam('mount', schemas.mount);
router.use(instanceRouter);

const serviceRouter = createRouter();
instanceRouter.use('/service', serviceRouter);

serviceRouter.get((req, res) => {
  res.json(serviceToJson(req.service));
})
.response(200, schemas.fullInfo)
.summary(`Service description`)
.description(dd`
  Fetches detailed information for the service at the given mount path.
`);

if (FoxxManager.isFoxxmaster()) {
  serviceRouter.patch(prepareServiceRequestBody, (req, res) => {
    const mount = req.queryParams.mount;
    FoxxManager.upgrade(req.body.source, mount, _.omit(req.queryParams, ['mount']));
    if (req.body.configuration) {
      FoxxManager.setConfiguration(mount, {configuration: req.body.configuration, replace: false});
    }
    if (req.body.dependencies) {
      FoxxManager.setDependencies(mount, {dependencies: req.body.dependencies, replace: false});
    }
    const service = FoxxManager.lookupService(mount);
    res.json(serviceToJson(service));
  })
  .body(schemas.service, ['application/javascript', 'application/zip', 'multipart/form-data', 'application/json'])
  .queryParam('teardown', schemas.flag.default(false))
  .queryParam('setup', schemas.flag.default(true))
  .queryParam('legacy', schemas.flag.default(false))
  .response(200, schemas.fullInfo);

  serviceRouter.put(prepareServiceRequestBody, (req, res) => {
    const mount = req.queryParams.mount;
    FoxxManager.replace(req.body.source, mount, _.omit(req.queryParams, ['mount']));
    if (req.body.configuration) {
      FoxxManager.setConfiguration(mount, {configuration: req.body.configuration, replace: true});
    }
    if (req.body.dependencies) {
      FoxxManager.setDependencies(mount, {dependencies: req.body.dependencies, replace: true});
    }
    const service = FoxxManager.lookupService(mount);
    res.json(serviceToJson(service));
  })
  .body(schemas.service, ['application/javascript', 'application/zip', 'multipart/form-data', 'application/json'])
  .queryParam('teardown', schemas.flag.default(true))
  .queryParam('setup', schemas.flag.default(true))
  .queryParam('legacy', schemas.flag.default(false))
  .response(200, schemas.fullInfo);

  serviceRouter.delete((req, res) => {
    FoxxManager.uninstall(
      req.queryParams.mount,
      _.omit(req.queryParams, ['mount'])
    );
    res.status(204);
  })
  .queryParam('teardown', schemas.flag.default(true))
  .response(204, null);
} else {
  serviceRouter.patch(FoxxManager.proxyToFoxxmaster);
  serviceRouter.put(FoxxManager.proxyToFoxxmaster);
  serviceRouter.delete(FoxxManager.proxyToFoxxmaster);
}

const configRouter = createRouter();
instanceRouter.use('/configuration', configRouter)
.response(200, schemas.configs);

configRouter.get((req, res) => {
  res.json(req.service.getConfiguration());
});

if (FoxxManager.isFoxxmaster()) {
  configRouter.patch((req, res) => {
    const warnings = FoxxManager.setConfiguration(req.service.mount, {
      configuration: req.body,
      replace: false
    });
    const values = req.service.getConfiguration(true);
    res.json({values, warnings});
  })
  .body(joi.object().required());

  configRouter.put((req, res) => {
    const warnings = FoxxManager.setConfiguration(req.service.mount, {
      configuration: req.body,
      replace: true
    });
    const values = req.service.getConfiguration(true);
    res.json({values, warnings});
  })
  .body(joi.object().required());
} else {
  configRouter.patch(FoxxManager.proxyToFoxxmaster);
  configRouter.put(FoxxManager.proxyToFoxxmaster);
}

const depsRouter = createRouter();
instanceRouter.use('/dependencies', depsRouter)
.response(200, schemas.deps);

depsRouter.get((req, res) => {
  res.json(req.service.getDependencies());
});

if (FoxxManager.isFoxxmaster()) {
  depsRouter.patch((req, res) => {
    const warnings = FoxxManager.setDependencies(req.service.mount, {
      dependencies: req.body,
      replace: true
    });
    const values = req.service.getDependencies(true);
    res.json({values, warnings});
  })
  .body(joi.object().required());

  depsRouter.put((req, res) => {
    const warnings = FoxxManager.setDependencies(req.service.mount, {
      dependencies: req.body,
      replace: true
    });
    const values = req.service.getDependencies(true);
    res.json({values, warnings});
  })
  .body(joi.object().required());
} else {
  depsRouter.patch(FoxxManager.proxyToFoxxmaster);
  depsRouter.put(FoxxManager.proxyToFoxxmaster);
}

const devRouter = createRouter();
instanceRouter.use('/development', devRouter)
.response(200, schemas.fullInfo);

devRouter.post((req, res) => {
  const service = FoxxManager.development(req.service.mount);
  res.json(serviceToJson(service));
});

devRouter.delete((req, res) => {
  const service = FoxxManager.production(req.service.mount);
  res.json(serviceToJson(service));
});

const scriptsRouter = createRouter();
instanceRouter.use('/scripts', scriptsRouter);

scriptsRouter.get((req, res) => {
  res.json(req.service.getScripts());
})
.response(200, joi.array().items(joi.object({
  name: joi.string().required(),
  title: joi.string().required()
}).required()).required());

scriptsRouter.post('/:name', (req, res) => {
  const service = req.service;
  const scriptName = req.pathParams.name;
  res.json(FoxxManager.runScript(scriptName, service.mount, [req.body]) || null);
})
.body(joi.any())
.pathParam('name', joi.string().required())
.response(200, joi.any().default(null));

instanceRouter.post('/tests', (req, res) => {
  const service = req.service;
  const reporter = req.queryParams.reporter || null;
  const result = FoxxManager.runTests(service.mount, {reporter});
  if (reporter === 'stream' && req.accepts(LDJSON, 'json') === LDJSON) {
    res.type(LDJSON);
    for (const row of result) {
      res.write(JSON.stringify(row) + '\r\n');
    }
  } else if (reporter === 'xunit' && req.accepts('xml', 'json') === 'xml') {
    res.type('xml');
    res.write('<?xml version="1.0" encoding="utf-8"?>\n');
    res.write(jsonml2xml(result) + '\n');
  } else if (reporter === 'tap' && req.accepts('text', 'json') === 'text') {
    res.type('text');
    for (const row of result) {
      res.write(row + '\n');
    }
  } else {
    res.json(result);
  }
})
.queryParam('reporter', joi.only(...reporters).optional())
.response(200, ['json', LDJSON, 'xml', 'text']);

instanceRouter.post('/download', (req, res) => {
  const service = req.service;
  const filename = service.mount.replace(/^\/|\/$/g, '').replace(/\//g, '_');
  res.attachment(`${filename}.zip`);
  if (!service.isDevelopment && fs.isFile(service.bundlePath)) {
    res.sendFile(service.bundlePath);
  } else {
    const tempFile = fs.getTempFile('bundles', false);
    FoxxManager._createServiceBundle(service.mount, tempFile);
    res.sendFile(tempFile);
    try {
      fs.remove(tempFile);
    } catch (e) {
      console.warnStack(e, `Failed to remove temporary Foxx download bundle: ${tempFile}`);
    }
  }
})
.response(200, ['application/zip']);

instanceRouter.get('/bundle', (req, res) => {
  const service = req.service;
  if (!fs.isFile(service.bundlePath)) {
    if (!service.mount.startsWith('/_')) {
      res.throw(404, 'Bundle not available');
    }
    FoxxManager._createServiceBundle(service.mount);
  }
  const checksum = `"${FoxxService.checksum(service.mount)}"`;
  if (req.get('if-none-match') === checksum) {
    res.status(304);
    return;
  }
  if (req.get('if-match') && req.get('if-match') !== checksum) {
    res.throw(404, 'No matching bundle available');
  }
  res.set('etag', checksum);
  const name = service.mount.replace(/^\/|\/$/g, '').replace(/\//g, '_');
  res.download(service.bundlePath, `${name}.zip`);
})
.response(200, ['application/zip'])
.header('if-match', joi.string().optional())
.header('if-none-match', joi.string().optional());

instanceRouter.get('/readme', (req, res) => {
  const service = req.service;
  const readme = service.readme;
  if (readme) {
    res.send(service.readme);
  } else {
    res.status(204);
  }
})
.response(200, ['text/plain'])
.response(204, null);

instanceRouter.get('/swagger', (req, res) => {
  swaggerJson(req, res, {
    mount: req.service.mount
  });
})
.response(200, joi.object());

const localRouter = createRouter();
router.use('/_local', localRouter);

localRouter.post((req, res) => {
  const result = {};
  for (const mount of Object.keys(req.body)) {
    const coordIds = req.body[mount];
    result[mount] = FoxxManager._installLocal(mount, coordIds);
  }
  FoxxManager._reloadRouting();
  res.json(result);
})
.body(joi.object());

localRouter.post('/service', (req, res) => {
  FoxxManager._reloadRouting();
})
.queryParam('mount', schemas.mount);

localRouter.delete('/service', (req, res) => {
  FoxxManager._uninstallLocal(req.queryParams.mount);
  FoxxManager._reloadRouting();
})
.queryParam('mount', schemas.mount);

localRouter.get('/status', (req, res) => {
  const ready = global.KEY_GET('foxx', 'ready');
  if (ready || FoxxManager.isFoxxmaster()) {
    res.json({ready});
    return;
  }
  FoxxManager.proxyToFoxxmaster(req, res);
  if (res.statusCode < 400) {
    const result = JSON.parse(res.body.toString('utf-8'));
    if (result.ready) {
      global.KEY_SET('foxx', 'ready', result.ready);
    }
  }
});

localRouter.get('/checksums', (req, res) => {
  const mountParam = req.queryParams.mount || [];
  const mounts = Array.isArray(mountParam) ? mountParam : [mountParam];
  const checksums = {};
  for (const mount of mounts) {
    try {
      checksums[mount] = FoxxService.checksum(mount);
    } catch (e) {
    }
  }
  res.json(checksums);
})
.queryParam('mount', joi.alternatives(
  joi.array().items(schemas.mount),
  schemas.mount
));

if (FoxxManager.isFoxxmaster()) {
  localRouter.post('/heal', (req, res) => {
    FoxxManager.heal();
  });
} else {
  localRouter.post('/heal', FoxxManager.proxyToFoxxmaster);
}
