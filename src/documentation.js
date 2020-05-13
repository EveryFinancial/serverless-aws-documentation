'use strict';

const objectHash = require('object-hash');
const _ = require('lodash');

const globalDocumentationParts = require('./globalDocumentationParts.json');
const functionDocumentationParts = require('./functionDocumentationParts.json');

function getDocumentationProperties(def, propertiesToGet) {
  const docProperties = new Map();
  propertiesToGet.forEach((key) => {
    if (def[key]) {
      docProperties.set(key, def[key]);
    }
  });
  return docProperties;
}

function _mapToObj(map) {
  const returnObj = {};
  map.forEach((val, key) => {
    returnObj[key] = val;
  });

  return returnObj;
}

/*
 * Different types support different extra properties beyond
 * the basic ones, so we need to make sure we only look for
 * the appropriate properties.
 */
function determinePropertiesToGet (type) {
  const defaultProperties = ['description', 'summary']
  let result = defaultProperties
  switch (type) {
    case 'API':
      result.push('tags', 'info')
      break
    case 'METHOD':
      result.push('tags')
      break
  }
  return result

}

var autoVersion;

module.exports = function() {
  return {
    _createDocumentationPart: function _createDocumentationPart(part, def, knownLocation) {
      const location = part.locationProps.reduce((loc, property) => {
        loc[property] = knownLocation[property] || def[property];
        return loc;
      }, {});
      location.type = part.type;
      const propertiesToGet = determinePropertiesToGet(location.type)

      const props = getDocumentationProperties(def, propertiesToGet);
      if (props.size > 0) {
        this.documentationParts.push({
          location,
          properties: _mapToObj(props),
          restApiId: this.restApiId,
        });
      }

      if (part.children) {
        this.createDocumentationParts(part.children, def, location);
      }
    },

    createDocumentationPart: function createDocumentationPart(part, def, knownLocation) {
      if (part.isList) {
        if (!(def instanceof Array)) {
          const msg = `definition for type "${part.type}" is not an array`;
          console.info('-------------------');
          console.info(msg);
          throw new Error(msg);
        }

        def.forEach((singleDef) => this._createDocumentationPart(part, singleDef, knownLocation));
      } else {
        this._createDocumentationPart(part, def, knownLocation);
      }
    },

    createDocumentationParts: function createDocumentationParts(parts, def, knownLocation) {
      Object.keys(parts).forEach((part) => {
        if (def[part]) {
          this.createDocumentationPart(parts[part], def[part], knownLocation);
        }
      });
    },

    _updateDocumentation: function _updateDocumentation() {
      const aws = this.serverless.providers.aws;
      return aws.request('APIGateway', 'getDocumentationVersion', {
        restApiId: this.restApiId,
        documentationVersion: this.getDocumentationVersion(),
      }).then(() => {
          const msg = 'documentation version already exists, skipping upload';
          console.info('-------------------');
          console.info(msg);
          return Promise.reject(msg);
        }, err => {
          if (err.message === 'Invalid Documentation version specified') {
            return Promise.resolve();
          }

          return Promise.reject(err);
        })
        .then(() =>
          aws.request('APIGateway', 'getDocumentationParts', {
            restApiId: this.restApiId,
            limit: 9999,
          })
        )
        .then(results => results.items.map(
          part => aws.request('APIGateway', 'deleteDocumentationPart', {
            documentationPartId: part.id,
            restApiId: this.restApiId,
          })
        ))
        .then(promises => Promise.all(promises))
        .then(() => this.documentationParts.reduce((promise, part) => {
          return promise.then(() => {
            part.properties = JSON.stringify(part.properties);
            return aws.request('APIGateway', 'createDocumentationPart', part);
          });
        }, Promise.resolve()))
        .then(() => aws.request('APIGateway', 'createDocumentationVersion', {
          restApiId: this.restApiId,
          documentationVersion: this.getDocumentationVersion(),
          stageName: this.options.stage,
        }));
    },

    _updateFunctionDocumentation: function _updateFunctionDocumentation() {
      const aws = this.serverless.providers.aws;

      return aws.request('APIGateway', 'getDocumentationParts', {
          restApiId: this.restApiId,
          limit: 9999
      })
      .then(results => results.items.map(
        part => {
          // Find a (generated) docPart that matches an (existing) part in APIGw
          var generatedPart = this.documentationParts.find(docPart =>
            part.location.type === docPart.location.type &&
            part.location.method === docPart.location.method &&
            part.location.statusCode === docPart.location.statusCode &&
            part.location.name === docPart.location.name &&
            part.location.path === '/' + docPart.location.path
          );
          if (generatedPart) {
            // part doesnt have restApiId
            // remove restApiId to be able to compare generatedPart against part
            generatedPart.properties = _.omit(generatedPart.properties, 'restApiId')
            // part is a stringified JSON - parse to compare to generatedPart JSON
            part.properties = JSON.parse(part.properties)
            
            if (_.isEqual(generatedPart.properties, part.properties)) {
              // console.info('Found identical existing documentation part:' + JSON.stringify(part));
              this.documentationParts = _.pull(this.documentationParts, generatedPart)

            } else {
              console.info('Remove outdated documentation part:' + JSON.stringify(part));
              return aws.request('APIGateway', 'deleteDocumentationPart', {
                documentationPartId: part.id,
                restApiId: this.restApiId,
              })
            }
          }
        }
      ))
      .then(promises => Promise.all(promises))
      .then(() => this.documentationParts.reduce((promise, part) => {
        return promise.then(() => {
          part.properties = JSON.stringify(part.properties);
          return aws.request('APIGateway', 'createDocumentationPart', part);         
        });
      }, Promise.resolve()));
    },

    getGlobalDocumentationParts: function getGlobalDocumentationParts() {
      if (!this.customVars.documentation) return;
      const globalDocumentation = this.customVars.documentation;
      this.createDocumentationParts(globalDocumentationParts, globalDocumentation, {});
    },

    getFunctionDocumentationParts: function getFunctionDocumentationParts() {
      const httpEvents = this._getHttpEvents();
      Object.keys(httpEvents).forEach(funcNameAndPath => {
        const httpEvent = httpEvents[funcNameAndPath];
        const path = httpEvent.path;
        const method = httpEvent.method.toUpperCase();
        this.createDocumentationParts(functionDocumentationParts, httpEvent, { path, method });
      });
    },

    _getHttpEvents: function _getHttpEvents() {
      return this.serverless.service.getAllFunctions().reduce((documentationObj, functionName) => {
        const func = this.serverless.service.getFunction(functionName);
        func.events
          .filter((eventTypes) => eventTypes.http && eventTypes.http.documentation)
          .map((eventTypes) => eventTypes.http)
          .forEach(currEvent => {
            let key = functionName + currEvent.method + currEvent.path;
            documentationObj[key] = currEvent;
          });
        return documentationObj;
      }, {});
    },

    generateAutoDocumentationVersion: function generateAutoDocumentationVersion() {
      const versionObject = {
        globalDocs: this.customVars.documentation,
        functionDocs: {},
      }

      const httpEvents = this._getHttpEvents();
      Object.keys(httpEvents).forEach(funcName => {
        versionObject.functionDocs[funcName] = httpEvents[funcName].documentation;
      });

      autoVersion = objectHash(versionObject);

      return autoVersion;
    },

    getDocumentationVersion: function getDocumentationVersion() {
        if (this.customVars.documentation && this.customVars.documentation.version) {
          return this.customVars.documentation.version;
        }
        return autoVersion || this.generateAutoDocumentationVersion();
    },

    _buildDocumentation: function _buildDocumentation(result) {
      this.restApiId = result.Stacks[0].Outputs
        .filter(output => output.OutputKey === 'AwsDocApiId')
        .map(output => output.OutputValue)[0];

      this.getGlobalDocumentationParts();
      this.getFunctionDocumentationParts();

      if (this.options.noDeploy) {
        console.info('-------------------');
        console.info('documentation parts:');
        console.info(this.documentationParts);
        return;
      }

      if (this.customVars.documentation) {
        return this._updateDocumentation();
      } else {
        return this._updateFunctionDocumentation();
      }
      
    },

    addDocumentationToApiGateway: function addDocumentationToApiGateway(resource, documentationPart, mapPath) {
      if (documentationPart && Object.keys(documentationPart).length > 0) {
        if (!resource.Properties.RequestParameters) {
          resource.Properties.RequestParameters = {};
        }

        documentationPart.forEach(function(qp) {
          const source = `method.request.${mapPath}.${qp.name}`;
          if (resource.Properties.RequestParameters.hasOwnProperty(source)) return; // don't mess with existing config
          resource.Properties.RequestParameters[source] = qp.required || false;
        });
      }
    },

    updateCfTemplateFromHttp: function updateCfTemplateFromHttp(eventTypes) {
      if (eventTypes.http && eventTypes.http.documentation) {
        const resourceName = this.normalizePath(eventTypes.http.path);
        const methodLogicalId = this.getMethodLogicalId(resourceName, eventTypes.http.method);
        const resource = this.cfTemplate.Resources[methodLogicalId];

        resource.DependsOn = new Set();
        this.addMethodResponses(resource, eventTypes.http.documentation);
        this.addRequestModels(resource, eventTypes.http.documentation);
        if (!this.options['doc-safe-mode']) {
          this.addDocumentationToApiGateway(
            resource,
            eventTypes.http.documentation.requestHeaders,
            'header'
          );
          this.addDocumentationToApiGateway(
            resource,
            eventTypes.http.documentation.queryParams,
            'querystring'
          );
          this.addDocumentationToApiGateway(
              resource,
              eventTypes.http.documentation.pathParams,
              'path'
          );
        }
        resource.DependsOn = Array.from(resource.DependsOn);
        if (resource.DependsOn.length === 0) {
          delete resource.DependsOn;
        }
        
        // If there is no documentation section, assume that models already exist in a shared apigateway
        if(!this.customVars.documentation) {
          delete resource.DependsOn;
        }
      }
    },

    _getDocumentationProperties: getDocumentationProperties
  };
};
