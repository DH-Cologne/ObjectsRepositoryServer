/* tslint:disable:max-line-length */
import * as flatten from 'flatten';
import { writeFileSync } from 'fs';
import { ensureDirSync } from 'fs-extra';
import * as imagemin from 'imagemin';
import * as pngquant from 'imagemin-pngquant';
import { Collection, Db, InsertOneWriteOpResult, MongoClient, ObjectId } from 'mongodb';

import { RootDirectory } from '../environment';
import { IAnnotation, ICompilation, ILDAPData, IMetaDataDigitalObject, IModel } from '../interfaces';

import { Configuration } from './configuration';
import { Logger } from './logger';
import { resolveCompilation, resolveDigitalObject, resolveModel } from './resolving-strategies';
import { isAnnotation, isCompilation, isDigitalObject, isModel } from './typeguards';
import { Utility } from './utility';
/* tslint:enable:max-line-length */

const MongoConf = Configuration.Mongo;
const UploadConf = Configuration.Uploads;

const ldap = (): Collection<ILDAPData> =>
  getAccountsRepository()
    .collection('ldap');
const getCurrentUserBySession = async (sessionID: string) =>
  ldap()
    .findOne({ sessionID });
const getUserByUsername = async (username: string) =>
  ldap()
    .findOne({ username });
const getAllItemsOfCollection = async (collection: string) =>
  getObjectsRepository()
    .collection(collection)
    .find({})
    .toArray();

const saveBase64toImage = async (
  base64input: string, subfolder: string, identifier: string | ObjectId) => {
  const saveId = identifier.toString();
  let finalImagePath = '';
  // TODO: Solve without try-catch block
  // TODO: Convert to progressive JPEG?
  try {
    if (base64input.indexOf('data:image') !== -1) {
      const replaced = base64input.replace(/^data:image\/(png|gif|jpeg);base64,/, '');
      const tempBuff = Buffer.from(replaced, 'base64');
      await imagemin.buffer(tempBuff, {
        plugins: [pngquant.default({
          speed: 1,
          strip: true,
          dithering: 1,
        })],
      })
        .then(res => {
          ensureDirSync(`${RootDirectory}/${UploadConf.UploadDirectory}/previews/${subfolder}/`);
          writeFileSync(
            `${RootDirectory}/${UploadConf.UploadDirectory}/previews/${subfolder}/${saveId}.png`,
            res);

          finalImagePath = `previews/${subfolder}/${saveId}.png`;
        })
        .catch(e => Logger.err(e));
    } else {
      finalImagePath = `previews/${base64input.split('previews/')[1]}`;
    }
  } catch (e) {
    Logger.err(e);
    return finalImagePath;
  }
  const https = Configuration.Express.enableHTTPS ? 'https' : 'http';
  const pubip = Configuration.Express.PublicIP;
  const port = Configuration.Express.Port;
  return `${https}://${pubip}:${port}/${finalImagePath}`;
};

const MongoURL = `mongodb://${MongoConf.Hostname}:${MongoConf.Port}/`;
const Client = new MongoClient(MongoURL, {
  useNewUrlParser: true,
  reconnectTries: Number.POSITIVE_INFINITY,
  reconnectInterval: 1000,
});
const getAccountsRepository = (): Db => Client.db(MongoConf.Databases.Accounts.Name);
const getObjectsRepository = (): Db => Client.db(MongoConf.Databases.ObjectsRepository.Name);

const Mongo = {
  init: async () => {
    await Client.connect(async (error, _) => {
      if (!error) return;
      Logger.err(
        `Couldn't connect to MongoDB. Make sure it is running and check your configuration`);
      process.exit(1);
    });
  },
  isMongoDBConnected: async (_, response, next) => {
    const isConnected = await Client.isConnected();
    if (isConnected) {
      next();
    } else {
      Logger.warn('Incoming request while not connected to MongoDB');
      response.send({ message: 'Cannot connect to Database. Contact sysadmin' });
    }
  },
  getAccountsRepository, getObjectsRepository,
  /**
   * Fix cases where an ObjectId is sent but it is not detected as one
   * used as Middleware
   */
  fixObjectId: async (request, _, next) => {
    if (request) {
      if (request.body && request.body['_id'] && ObjectId.isValid(request.body['_id'])) {
        request.body['_id'] = new ObjectId(request.body['_id']);
      }
    }
    next();
  },
  getUnusedObjectId: async (_, response) => {
    response.send(new ObjectId());
  },
  invalidateSession: async (request, response) => {
    const sessionID = request.sessionID;
    ldap()
      .updateMany({ sessionID }, { $set: { sessionID: '' } }, () => {
        Logger.log('Logged out');
        response.send({ status: 'ok', message: 'Logged out' });
      });
  },
  updateSessionId: async (request, response, next) => {
    const user = request.user;
    const username = request.body.username.toLowerCase();
    const sessionID = request.sessionID;
    const userData = await getUserByUsername(username) || {};

    const updateResult = await ldap()
      .updateOne({ username }, {
        $set: {
          username,
          sessionID,
          fullname: user['cn'],
          prename: user['givenName'],
          surname: user['sn'],
          rank: user['UniColognePersonStatus'],
          mail: user['mail'],
          role: (userData['role'])
            ? ((userData['role'] === '')
              ? user['UniColognePersonStatus']
              : userData['role'])
            : user['UniColognePersonStatus'],
        },
      });

    if (updateResult.result.ok !== 1) {
      return response.send({ status: 'error', message: 'Failed updating user in database' });
    }
    next();
  },
  addToAccounts: async (request, response) => {
    const user = request.user;
    const username = request.body.username.toLowerCase();
    const sessionID = request.sessionID;
    const userData = await getUserByUsername(username);

    if (!userData) {
      ldap()
        .insertOne(
          {
            _id: new ObjectId(),
            username,
            sessionID,
            fullname: user['cn'],
            prename: user['givenName'],
            surname: user['sn'],
            rank: user['UniColognePersonStatus'],
            mail: user['mail'],
            data: {},
            role: user['UniColognePersonStatus'],
          },
          (ins_err, ins_res) => {
            if (ins_err) {
              response.send({ status: 'error' });
              Logger.err(ins_res);
            } else {
              Logger.info(ins_res.ops);
              response.send({ status: 'ok', ...ins_res.ops[0] });
            }
          });
    } else {
      ldap()
        .updateOne(
          { username },
          {
            $set: {
              sessionID,
              fullname: user['cn'],
              prename: user['givenName'],
              surname: user['sn'],
              rank: user['UniColognePersonStatus'],
              mail: user['mail'],
              role: (userData['role'])
                ? ((userData['role'] === '')
                  ? user['UniColognePersonStatus']
                  : userData['role'])
                : user['UniColognePersonStatus'],
            },
          },
          (up_err, _) => {
            if (up_err) {
              response.send({ status: 'error' });
              Logger.err(up_err);
            } else {
              ldap()
                .findOne({ sessionID, username }, (f_err, f_res) => {
                  if (f_err) {
                    response.send({ status: 'error' });
                    Logger.err(f_err);
                  } else {
                    response.send({ status: 'ok', ...f_res });
                  }
                });
            }
          });
    }
  },
  insertCurrentUserData: async (request, identifier, collection) => {
    const sessionID = request.sessionID;
    const userData = await getCurrentUserBySession(sessionID);

    if (!ObjectId.isValid(identifier) || !userData) return false;

    userData.data[collection] = (userData.data[collection])
      ? userData.data[collection] : [];

    const doesExist = userData.data[collection]
      .filter(obj => obj)
      .find((obj: any) => obj.toString() === identifier.toString());

    if (doesExist) return true;

    userData.data[collection].push(new ObjectId(identifier));
    const updateResult = await ldap()
      .updateOne(
        { sessionID }, { $set: { data: userData.data } });

    if (updateResult.result.ok !== 1) return false;
    return true;
  },
  getCurrentUserData: async (request, response) => {
    const sessionID = request.sessionID;
    const userData = await getCurrentUserBySession(sessionID);
    if (!userData || !userData.data) {
      return response
        .send({ status: 'error', message: 'User not found by sessionID. Try relogging' });
    }
    for (const property in userData.data) {
      if (!userData.data.hasOwnProperty(property)) continue;
      userData.data[property] = await Promise.all(
        userData.data[property].map(async obj => Mongo.resolve(obj, property)));
      // Filter possible null's
      userData.data[property] = userData.data[property].filter(obj => obj);
    }
    // Add model owners to models
    if (userData.data.model && userData.data.model.length > 0) {
      for (const model of userData.data.model) {
        if (!model) continue;
        model['relatedModelOwners'] =
          await Utility.findAllModelOwners(model['_id']);
      }
    }

    response.send({ status: 'ok', ...userData });
  },
  validateLoginSession: async (request, response, next) => {
    const sessionID = request.sessionID = (request.cookies['connect.sid']) ?
      request.cookies['connect.sid'].substr(2, 36) : request.sessionID;

    const userData = await getCurrentUserBySession(sessionID);
    if (!userData) {
      return response.send({ status: 'error', message: 'Invalid session' });
    }
    next();
  },
  submitService: async (request, response) => {
    const digobjCollection: Collection<IMetaDataDigitalObject> =
      getObjectsRepository()
        .collection('digitalobject');
    const modelCollection: Collection<IModel> =
      getObjectsRepository()
        .collection('model');

    const service: string = request.params.service;
    if (!service) response.send({ status: 'error', message: 'Incorrect request' });

    const mapTypes = (resType: string) => {
      let type = resType;
      type = type.toLowerCase();
      switch (type) {
        case 'sound': type = 'audio'; break;
        case 'picture': type = 'image'; break;
        case '3d': type = 'model'; break;
        default:
      }
      return type;
    };

    // After adding a digitalobject inside of a model,
    // attach data to the current user
    const insertFinalModelToCurrentUser = (modelResult: InsertOneWriteOpResult) => {
      Mongo.insertCurrentUserData(request, modelResult.ops[0]._id, 'model')
        .then(() => {
          response.send({ status: 'ok', result: modelResult.ops[0] });
          Logger.info('Added Europeana object', modelResult.ops[0]._id);
        })
        .catch(err => {
          Logger.err(err);
          response.send({ status: 'error', message: 'Failed adding finalized object to user' });
        });
    };

    // After adding a digitalobject, add digitalobject
    // to a model and push the model
    const pushModel = (digobjResult: InsertOneWriteOpResult) => {
      const resultObject = digobjResult.ops[0];
      const modelObject: IModel = {
        _id: new ObjectId(),
        annotationList: [],
        relatedDigitalObject: {
          _id: resultObject._id,
        },
        name: resultObject.digobj_title,
        ranking: 0,
        files: [],
        finished: true,
        online: true,
        mediaType: mapTypes(request.body.type),
        dataSource: {
          isExternal: true,
          service,
        },
        processed: {
          low: request.body._fileUrl,
          medium: request.body._fileUrl,
          high: request.body._fileUrl,
          raw: request.body._fileUrl,
        },
        settings: {
          preview: (request.body._previewUrl)
            ? request.body._previewUrl
            : '/previews/noimage.png',
        },
      };
      modelCollection.insertOne(modelObject)
        .then(insertFinalModelToCurrentUser)
        .catch(err => {
          Logger.err(err);
          response.send({ status: 'error', message: 'Failed finalizing digitalobject' });
        });
    };

    switch (service) {
      case 'europeana':
        // TODO: Put into Europeana service to make every service self sustained?
        const EuropeanaObject: IMetaDataDigitalObject = {
          _id: new ObjectId(),
          digobj_type: mapTypes(request.body.type),
          digobj_title: request.body.title,
          digobj_description: request.body.description,
          digobj_licence: request.body.license,
          digobj_externalLink: [{
            externalLink_description: 'Europeana URL',
            externalLink_value: request.body.page,
          }],
          digobj_externalIdentifier: [],
          digobj_discipline: [],
          digobj_creation: [],
          digobj_dimensions: [],
          digobj_files: [],
          digobj_objecttype: '',
          digobj_person: [],
          digobj_rightsowner: [],
          digobj_statement: '',
          digobj_tags: [],
          digobj_metadata_files: [],
          digobj_person_existing: [],
          digobj_rightsowner_institution: [],
          digobj_rightsowner_person: [],
          digobj_rightsownerSelector: 1,
          digobj_person_existing_role: [],
          contact_person: [],
          contact_person_existing: [],
          phyObjs: [],
        };

        digobjCollection.insertOne(EuropeanaObject)
          .then(pushModel)
          .catch(err => {
            Logger.err(err);
            response.send({ status: 'error', message: `Couldn't add as digitalobject` });
          });

        break;
      default:
        response.send({ status: 'error', message: `Service ${service} not configured` });
    }
  },
  /**
   * When the user submits the metadataform this function
   * adds the missing data to defined collections
   */
  submit: async (request, response) => {
    Logger.info('Handling submit request');

    const collection: Collection<IMetaDataDigitalObject> =
      getObjectsRepository()
        .collection('digitalobject');
    const resultObject: IMetaDataDigitalObject = { ...request.body };

    /**
     * Handle re-submit for changing a finished DigitalObject
     */
    const isResObjIdValid = ObjectId.isValid(resultObject._id);
    resultObject._id = isResObjIdValid
      ? new ObjectId(resultObject._id) : new ObjectId();
    Logger.info(`${isResObjIdValid ? 'Re-' : ''}Submitting DigitalObject ${resultObject._id}`);

    // We overwrite this in the phyobj loop so we can
    let currentPhyObjId = '';

    //// FILTER FUNCTIONS ////
    const addToRightsOwnerFilter = (person: any) =>
      person['value'] && person['value'].indexOf('add_to_new_rightsowner') !== -1;
    const filterObjectsWithoutID = (obj: any) => ObjectId.isValid(obj._id);

    /**
     * Adds data {field} to a collection {collection}
     * and returns the {_id} of the created object.
     * If {field} already has an {_id} property the server
     * will assume the object already exists in the collection
     * and instead return the existing {_id}
     */
    const addAndGetId = async (in_field, add_to_coll, new_roles?) => {
      let field = in_field;
      if (add_to_coll === 'person') {
        field = await addNestedInstitution(field);
      }
      const coll: Collection = getObjectsRepository()
        .collection(add_to_coll);
      const isPersonOrInstitution = ['person', 'institution'].includes(add_to_coll);
      const _digId = ((currentPhyObjId !== '') ? currentPhyObjId : resultObject._id)
        .toString();
      // By default, update/create the document
      // but if its an existing person/institution
      // fetch the object and update roles
      const isIdValid = ObjectId.isValid(field['_id']);
      const _id = (isIdValid) ? new ObjectId(field['_id']) : new ObjectId();
      if (isIdValid) {
        const findResult = await coll.findOne({ _id });
        if (findResult) {
          field = { ...findResult, ...field };
        }
      }
      if (isPersonOrInstitution) {
        const doRolesExist = (field['roles'] !== undefined);

        field['roles'] = doRolesExist ? field['roles'] : {};
        field['roles'][_digId] = field['roles'][_digId]
          ? field['roles'][_digId]
          : [];

        for (const prop of ['institution_role', 'person_role']) {
          if (!field[prop]) continue;
          field[prop] = (new_roles) ? new_roles : field[prop];
          // Add new roles to person or institution
          field['roles'][_digId] = doRolesExist
            ? flatten([field['roles'][_digId], field[prop]])
            : flatten([field[prop]]);
          field['roles'][_digId] = Array.from(new Set(field['roles'][_digId]));
          field[prop] = [];
        }
      }

      // Make sure there are no null roles
      if (field['roles'] && field['roles'][_digId]) {
        field['roles'][_digId] = field['roles'][_digId].filter(obj => obj);
      }
      // We cannot update _id property when upserting
      // so we remove this beforehand
      // tslint:disable-next-line
      delete field['_id'];
      const updateResult = await coll.updateOne(
        { _id },
        { $set: field, $setOnInsert: { _id } },
        { upsert: true });

      const resultId = (updateResult.upsertedId)
        ? updateResult.upsertedId._id
        : _id;
      return { _id: resultId };
    };

    const addNestedInstitution = async person => {
      if (!person['person_institution']) return person;
      if (!(person['person_institution'] instanceof Array)) return person;
      for (let i = 0; i < person['person_institution'].length; i++) {
        if (person['person_institution'][i]['value'] !== 'add_new_institution') continue;
        const institution = person['person_institution_data'][i];
        const newInst = await addAndGetId(institution, 'institution');
        person['person_institution_data'][i] = newInst;
      }
      return person;
    };

    const concatFix = (...arr: any[]) => {
      let result: any[] = [].concat(arr[0]);
      for (let i = 1; i < arr.length; i++) {
        result = result.concat(arr[i]);
      }
      result = result.filter(filterObjectsWithoutID);
      const final: any[] = [];
      for (const res of result) {
        const obj = { _id: new ObjectId(res._id) };
        const filtered = final.filter(_obj => _obj._id.toString() === obj._id.toString());
        if (filtered.length === 0) final.push(obj);
      }
      return final;
    };

    // Always single
    let digobj_rightsowner: any[] = resultObject['digobj_rightsowner'];
    let digobj_rightsowner_person: any[] = resultObject['digobj_rightsowner_person'];
    let digobj_rightsowner_institution: any[] = resultObject['digobj_rightsowner_institution'];
    // Can be multiple
    let contact_person: any[] = resultObject['contact_person'];
    let contact_person_existing: any[] = resultObject['contact_person_existing'];
    let digobj_person: any[] = resultObject['digobj_person'];
    let digobj_person_existing: any[] = resultObject['digobj_person_existing'];
    const digobj_tags: any[] = resultObject['digobj_tags'];
    const phyObjs: any[] = resultObject['phyObjs'];

    const handleRightsOwnerBase = async (
      inArr: any[], existArrs: any[],
      roleProperty: string, add_to_coll: string, fixedRoles?: any[]) => {
      for (let x = 0; x < inArr.length; x++) {
        const toConcat: any = [];
        for (const existArr of existArrs) {
          const filtered = existArr.filter(addToRightsOwnerFilter);
          if (filtered.length !== 1) continue;
          const roles = (filtered[0][roleProperty] && filtered[0][roleProperty].length > 0)
            ? filtered[0][roleProperty] : fixedRoles;
          toConcat.push(roles);
        }
        const newRoles = flatten([inArr[x][roleProperty], toConcat]);
        inArr[x] = await addAndGetId(inArr[x], add_to_coll, newRoles);
      }
    };

    await handleRightsOwnerBase(
      digobj_rightsowner_person, [digobj_person_existing, contact_person_existing],
      'person_role', 'person', ['CONTACT_PERSON']);

    const handleRightsOwnerSelector = async (
      inArr: any[],
      personArr: any[],
      instArr: any[],
      selector: any) => {
      for (const obj of inArr) {
        switch (obj['value']) {
          case 'add_new_person':
            personArr[0] = await addAndGetId({ ...personArr[0] }, 'person');
            break;
          case 'add_new_institution':
            instArr[0] = await addAndGetId({ ...instArr[0] }, 'institution');
            break;
          default:
            const newRightsOwner = { ...obj };
            const personSelector = 1;
            const instSelector = 2;
            const selected = parseInt(selector, 10);
            switch (selected) {
              case personSelector:
                personArr[0] = await addAndGetId(newRightsOwner, 'person');
                break;
              case instSelector:
                instArr[0] = await addAndGetId(newRightsOwner, 'institution');
                break;
              default:
            }
        }
      }
    };

    await handleRightsOwnerSelector(
      digobj_rightsowner, digobj_rightsowner_person,
      digobj_rightsowner_institution, resultObject['digobj_rightsownerSelector']);

    /**
     * Newly added rightsowner persons and institutions can be
     * selected in other input fields as 'same as new rightsowner'.
     * this function handles these cases
     */
    const handleRightsOwnerAndExisting = async (
      inArr: any[],
      outArr: any[],
      add_to_coll: string,
      idIfSame: string | ObjectId,
      roleProperty: string,
      role?: string) => {
      for (const obj of inArr) {
        const newObj = {};
        newObj[roleProperty] = (role) ? role : obj[roleProperty];
        newObj['_id'] = ObjectId.isValid(obj['_id']) ? new ObjectId(obj['_id'])
          : (ObjectId.isValid(idIfSame) ? new ObjectId(idIfSame) : new ObjectId());
        const newRoles = newObj[roleProperty];
        outArr.push(await addAndGetId(newObj, add_to_coll, newRoles));
      }
    };

    /**
     * Simple cases where the item only needs to be added for nesting
     */
    const handleSimpleCases = async (inArrAndOutArr: any[], add_to_coll: string) => {
      for (let i = 0; i < inArrAndOutArr.length; i++) {
        inArrAndOutArr[i] = await addAndGetId(inArrAndOutArr[i], add_to_coll);
      }
    };

    await handleSimpleCases(digobj_rightsowner_institution, 'institution');
    await handleSimpleCases(contact_person, 'person');
    await handleSimpleCases(digobj_person, 'person');
    await handleSimpleCases(digobj_tags, 'tag');

    /**
     * Cases where persons either exist or are added to the new rightsowner
     */
    const _tempId = (digobj_rightsowner_person[0] && digobj_rightsowner_person[0]['_id'])
      ? digobj_rightsowner_person[0]['_id'] : '';
    await handleRightsOwnerAndExisting(
      contact_person_existing, contact_person, 'person',
      _tempId, 'person_role', 'CONTACT_PERSON');
    await handleRightsOwnerAndExisting(
      digobj_person_existing, digobj_person, 'person',
      _tempId, 'person_role');

    for (let i = 0; i < phyObjs.length; i++) {
      const phyObj: any[] = phyObjs[i];
      let phyobj_rightsowner: any[] = phyObj['phyobj_rightsowner'];
      let phyobj_rightsowner_person: any[] = phyObj['phyobj_rightsowner_person'];
      let phyobj_rightsowner_institution: any[] = phyObj['phyobj_rightsowner_institution'];
      let phyobj_person: any[] = phyObj['phyobj_person'];
      let phyobj_person_existing: any[] = phyObj['phyobj_person_existing'];
      let phyobj_institution: any[] = phyObj['phyobj_institution'];
      let phyobj_institution_existing: any[] = phyObj['phyobj_institution_existing'];

      const isPhyObjIdValid = ObjectId.isValid(phyObj['_id']);
      phyObj['_id'] = isPhyObjIdValid ? new ObjectId(phyObj['_id']) : new ObjectId();
      currentPhyObjId = phyObj['_id'];

      await handleRightsOwnerBase(
        phyobj_rightsowner_person, [phyobj_person_existing],
        'person_role', 'person');
      await handleRightsOwnerBase(
        phyobj_rightsowner_institution, [phyobj_institution_existing],
        'institution_role', 'institution');

      await handleRightsOwnerSelector(
        phyobj_rightsowner, phyobj_rightsowner_person,
        phyobj_rightsowner_institution, phyObj['phyobj_rightsownerSelector']);

      await handleSimpleCases(phyobj_person, 'person');
      await handleSimpleCases(phyobj_institution, 'institution');

      if (phyobj_rightsowner_person[0]) {
        await handleRightsOwnerAndExisting(
          phyobj_person_existing, phyobj_person, 'person',
          phyobj_rightsowner_person[0]['_id'], 'person_role');
      } else if (phyobj_rightsowner_institution[0]) {
        await handleRightsOwnerAndExisting(
          phyobj_institution_existing, phyobj_institution, 'institution',
          phyobj_rightsowner_institution[0]['_id'], 'institution_role');
      }

      await handleRightsOwnerAndExisting(
        phyobj_person_existing, phyobj_person, 'person',
        '', 'person_role');
      await handleRightsOwnerAndExisting(
        phyobj_institution_existing, phyobj_institution, 'institution',
        '', 'institution_role');

      phyobj_rightsowner =
        concatFix(phyobj_rightsowner, phyobj_rightsowner_institution, phyobj_rightsowner_person);
      phyobj_person_existing = concatFix(phyobj_person_existing, phyobj_person);
      phyobj_institution_existing = concatFix(phyobj_institution_existing, phyobj_institution);
      phyobj_rightsowner_institution = phyobj_rightsowner_person =
        phyobj_person = phyobj_institution = [];
      const finalPhy = {
        ...phyObj, phyobj_rightsowner, phyobj_rightsowner_person,
        phyobj_rightsowner_institution, phyobj_person, phyobj_person_existing,
        phyobj_institution, phyobj_institution_existing,
      };
      phyObjs[i] = await addAndGetId(finalPhy, 'physicalobject');
    }

    /**
     * Re-assignment:
     * When editing a finished object we want to have all persons/institutions that have been added
     * on the previous submit to be existing persons/institutions, otherwise they would fill up
     * the metadata form in the frontend
     * Also: remove everything without an _id (which is the remainings from tag-input)
     */
    digobj_person_existing = concatFix(digobj_person_existing, digobj_person);
    contact_person_existing = concatFix(contact_person_existing, contact_person);
    digobj_rightsowner =
      concatFix(digobj_rightsowner, digobj_rightsowner_institution, digobj_rightsowner_person);

    // Empty the arrays that contained newly created persons/institutions
    digobj_rightsowner_institution = digobj_rightsowner_person =
      contact_person = digobj_person = [];

    const finalObject = {
      ...resultObject, digobj_rightsowner_person, digobj_rightsowner_institution,
      contact_person, contact_person_existing, digobj_person_existing,
      digobj_person, digobj_tags, phyObjs, digobj_rightsowner,
    };

    collection.updateOne({ _id: finalObject['_id'] }, { $set: finalObject }, { upsert: true })
      .then(() => Mongo.resolve(finalObject['_id'], 'digitalobject'))
      .then(data => {
        Logger.info(`Finished Object ${finalObject['_id']}`);
        response.send({ status: 'ok', data });
      })
      .catch(e => {
        Logger.err(e);
        response.send({ status: 'error', message: 'Failed to add' });
      });
  },
  addObjectToCollection: async (request, response) => {
    const RequestCollection = request.params.collection.toLowerCase();

    Logger.info(`Adding to the following collection: ${RequestCollection}`);

    const collection: Collection = getObjectsRepository()
      .collection(RequestCollection);
    const sessionID = request.sessionID;

    const resultObject = request.body;
    const userData = await getCurrentUserBySession(sessionID);
    if (!userData) {
      response.send({ status: 'error', message: 'Cannot fetch current user from database' });
      return;
    }

    const isValidObjectId = ObjectId.isValid(resultObject['_id']);
    const doesObjectExist: any | null = await Mongo.resolve(resultObject, RequestCollection, 0);
    // If the object already exists we need to check for owner status
    if (isValidObjectId && doesObjectExist) {
      const isOwner = await Mongo.isUserOwnerOfObject(request, resultObject['_id']);
      if (!isOwner) {
        response.send({ status: 'error', message: 'Permission denied' });
        return;
      }
    }

    const _id = isValidObjectId
      ? new ObjectId(resultObject._id)
      : new ObjectId();

    resultObject._id = _id;

    if (isCompilation(resultObject)) {
      resultObject.annotationList = (resultObject.annotationList)
        ? resultObject.annotationList : [];
      resultObject.relatedOwner = {
        _id: userData._id,
        username: userData.username,
        fullname: userData.fullname,
      };
      // Compilations should have all their models referenced by _id
      resultObject.models =
        resultObject.models
          .filter(model => model)
          .map((model: IModel) => ({ _id: new ObjectId(model['_id']) }));
    } else if (isModel(resultObject)) {
      /* Preview image URLs might have a corrupted address
       * because of Kompakkt runnning in an iframe
       * This removes the host address from the URL
       * so images will load correctly */
      if (resultObject.settings && resultObject.settings.preview) {
        resultObject.settings.preview = await saveBase64toImage(
          resultObject.settings.preview, 'model', resultObject._id);
      }
    } else if (isAnnotation(resultObject)) {
      // Check if anything was missing for safety
      if (!resultObject || !resultObject.target || !resultObject.target.source) {
        return response.send({
          status: 'error', message: 'Invalid annotation',
          invalidObject: resultObject,
        });
      }
      const source = resultObject.target.source;
      if (!source) {
        response.send({ status: 'error', message: 'Missing source' });
        return;
      }
      if (!resultObject.body || !resultObject.body.content
        || !resultObject.body.content.relatedPerspective) {
        return response
          .send({ status: 'error', message: 'Missing body.content.relatedPerspective' });
      }
      resultObject.body.content.relatedPerspective.preview = await saveBase64toImage(
        resultObject.body.content.relatedPerspective.preview, 'annotation', resultObject._id);

      const relatedModelId: string | undefined = source.relatedModel;
      const relatedCompId: string | undefined = source.relatedCompilation;
      // Check if === undefined because otherwise this quits on empty string
      if (relatedModelId === undefined || relatedCompId === undefined) {
        response.send({ status: 'error', message: 'Related model or compilation undefined' });
        return;
      }

      const validModel = ObjectId.isValid(relatedModelId);
      const validCompilation = ObjectId.isValid(relatedCompId);

      if (!validModel) {
        response.send({ status: 'error', message: 'Invalid related model id' });
        return;
      }

      if (validModel && !validCompilation) {
        const isOwner =
          await Mongo.isUserOwnerOfObject(request, relatedModelId);
        if (!isOwner) {
          response.send({ status: 'error', message: 'Permission denied' });
          return;
        }
      }

      // Update data inside of annotation
      resultObject.generated = (resultObject.generated)
        ? resultObject.generated : new Date().toISOString();
      resultObject.lastModificationDate = new Date().toISOString();

      const updateAnnotationList = async (id: string, add_to_coll: string) => {
        const obj: IModel | ICompilation = await Mongo.resolve(id, add_to_coll, 0);
        // Create annotationList if missing
        obj.annotationList = (obj.annotationList)
          ? obj.annotationList : [];
        // Filter null
        obj.annotationList = obj.annotationList
          .filter(annotation => annotation);

        const doesAnnotationExist = obj.annotationList
          .filter(annotation => annotation)
          .find((annotation: IAnnotation) =>
            (annotation._id) ? annotation._id.toString() === resultObject._id.toString()
              : annotation.toString() === resultObject._id.toString());
        if (doesAnnotationExist) return true;

        // Add annotation to list if it doesn't exist
        const _newId = new ObjectId(resultObject._id);
        obj.annotationList.push(_newId);

        // We resolved the compilation earlier, so now we have to replace
        // the resolved annotations with their ObjectId again
        obj.annotationList = obj.annotationList
          .map((annotation: IAnnotation) =>
            (annotation._id) ? new ObjectId(annotation._id) : annotation);

        // Finally we update the annotationList in the compilation
        const coll: Collection = getObjectsRepository()
          .collection(add_to_coll);
        const listUpdateResult = await coll
          .updateOne(
            { _id: new ObjectId(id) },
            { $set: { annotationList: obj.annotationList } });

        if (listUpdateResult.result.ok !== 1) {
          Logger.err(`Failed updating annotationList of ${add_to_coll} ${id}`);
          response.send({ status: 'error' });
          return false;
        }
        return true;
      };

      const success = (!validCompilation)
        // Annotation is default annotation
        ? await updateAnnotationList(relatedModelId, 'model')
        // Annotation belongs to compilation
        : await updateAnnotationList(relatedCompId, 'compilation');

      if (!success) {
        Logger.err(`Failed updating annotationList`);
        response.send({ status: 'error' });
        return;
      }
    }

    const updateResult = await collection
      .updateOne({ _id }, { $set: resultObject }, { upsert: true });

    if (updateResult.result.ok !== 1) {
      Logger.err(`Failed updating ${RequestCollection} ${_id}`);
      response.send({ status: 'error' });
      return;
    }

    await Mongo.insertCurrentUserData(request, _id, RequestCollection);

    const resultId = (updateResult.upsertedId) ? updateResult.upsertedId._id : _id;
    response.send({ status: 'ok', ...await Mongo.resolve(resultId, RequestCollection) });
    Logger.info(`Success! Updated ${RequestCollection} ${_id}`);
  },
  updateModelSettings: async (request, response) => {
    const preview = request.body.preview;
    const identifier = (ObjectId.isValid(request.params.identifier)) ?
      new ObjectId(request.params.identifier) : request.params.identifier;
    const collection: Collection = getObjectsRepository()
      .collection('model');
    const subfolder = 'model';

    const finalImagePath = await saveBase64toImage(preview, subfolder, identifier);
    if (finalImagePath === '') {
      return response
        .send({ status: 'error', message: 'Failed saving preview image' });
    }

    // Overwrite old settings
    const settings = { ...request.body, preview: finalImagePath };
    const result = await collection.updateOne(
      { _id: identifier },
      { $set: { settings } });
    response.send((result.result.ok === 1) ? { status: 'ok', settings } : { status: 'error' });
  },
  isUserOwnerOfObject: async (request, identifier) => {
    const _id = ObjectId.isValid(identifier)
      ? new ObjectId(identifier) : identifier;
    const userData = await getCurrentUserBySession(request.sessionID);
    return JSON.stringify((userData) ? userData.data : '')
      .indexOf(_id) !== -1;
  },
  isUserAdmin: async (request): Promise<boolean> => {
    const userData = await getCurrentUserBySession(request.sessionID);
    return (userData) ? userData.role === 'A' : false;
  },
  /**
   * Simple resolving by collection name and Id
   */
  resolve: async (
    obj: any, collection_name: string, depth?: number): Promise<any | null | undefined> => {
    if (!obj) return undefined;
    const parsedId = (obj['_id']) ? obj['_id'] : obj;
    if (!ObjectId.isValid(parsedId)) return;
    const _id = new ObjectId(parsedId);
    Logger.info(`Resolving ${collection_name} ${_id}`);
    const resolve_collection: Collection = getObjectsRepository()
      .collection(collection_name);
    return resolve_collection.findOne({ $or: [ { _id }, { _id: _id.toString() } ] })
      .then(resolve_result => {
        if (depth && depth === 0) return resolve_result;

        if (isDigitalObject(resolve_result)) {
          return resolveDigitalObject(resolve_result);
        }
        if (isModel(resolve_result)) {
          return resolveModel(resolve_result);
        }
        if (isCompilation(resolve_result)) {
          return resolveCompilation(resolve_result);
        }
        return resolve_result;
      });
  },
  getObjectFromCollection: async (request, response) => {
    const RequestCollection = request.params.collection.toLowerCase();

    const _id = (ObjectId.isValid(request.params.identifier)) ?
      new ObjectId(request.params.identifier) : request.params.identifier;
    const password = (request.params.password) ? request.params.password : '';
    const object = await Mongo.resolve(_id, RequestCollection);
    if (!object) {
      return response
        .send({ status: 'error', message: `No ${RequestCollection} found with given identifier` });
    }

    if (isCompilation(object)) {
      const compilation = object;
      const _pw = compilation.password;
      const isPasswordProtected = (_pw && _pw.length > 0);
      const isUserOwner = await Mongo.isUserOwnerOfObject(request, _id);
      const isPasswordCorrect = (_pw && _pw === password);

      if (!isPasswordProtected || isUserOwner || isPasswordCorrect) {
        response.send({ status: 'ok', ...compilation });
        return;
      }

      response.send({ status: 'ok', message: 'Password protected compilation' });
    } else {
      response.send({ status: 'ok', ...object });
    }
  },
  getAllObjectsFromCollection: async (request, response) => {
    const RequestCollection = request.params.collection.toLowerCase();
    let results = await getAllItemsOfCollection(RequestCollection);

    for (let i = 0; i < results.length; i++) {
      results[i] = await Mongo.resolve(results[i], RequestCollection);
    }
    results = results.filter(_ => _);

    if (results.length > 0 && isCompilation(results[0])) {
      const isPasswordProtected = compilation =>
        (!compilation.password || (compilation.password && compilation.password.length === 0));
      results = results.filter(isPasswordProtected);
    }

    response.send(results);
  },
  removeObjectFromCollection: async (request, response) => {
    const RequestCollection = request.params.collection.toLowerCase();

    const collection = getObjectsRepository()
      .collection(RequestCollection);
    const sessionID = request.sessionID;

    const identifier = (ObjectId.isValid(request.params.identifier)) ?
      new ObjectId(request.params.identifier) : request.params.identifier;

    const find_result = await getCurrentUserBySession(sessionID);

    if (!find_result || (!find_result.username || !request.body.username)
      || (request.body.username !== find_result.username)) {
      Logger.err(`Object removal failed due to username & session not matching`);
      response.send({
        status: 'error',
        message: 'Input username does not match username with current sessionID',
      });
      return;
    }

    // Flatten account.data so its an array of ObjectId.toString()
    const UserRelatedObjects =
      Array.prototype.concat(...Object.values(find_result.data))
        .map(id => id.toString());

    if (!UserRelatedObjects.find(obj => obj === identifier.toString())) {
      Logger.err(`Object removal failed because Object does not belong to user`);
      response.send({
        status: 'error',
        message: 'Object with identifier does not belong to account with this sessionID',
      });
      return;
    }
    const delete_result = await collection.deleteOne({ _id: identifier });
    if (delete_result.result.ok === 1) {
      find_result.data[RequestCollection] =
        find_result.data[RequestCollection].filter(id => id !== identifier.toString());

      const update_result =
        await ldap()
          .updateOne({ sessionID }, { $set: { data: find_result.data } });

      if (update_result.result.ok === 1) {
        Logger.info(`Deleted ${RequestCollection} ${request.params.identifier}`);
        response.send({ status: 'ok' });
      } else {
        Logger.warn(`Failed deleting ${RequestCollection} ${request.params.identifier}`);
        response.send({ status: 'error' });
      }
    } else {
      Logger.warn(`Failed deleting ${RequestCollection} ${request.params.identifier}`);
      Logger.warn(delete_result);
      response.send({ status: 'error' });
    }
  },
  searchObjectWithFilter: async (request, response) => {
    const RequestCollection = request.params.collection.toLowerCase();

    const filter = (request.body.filter) ? request.body.filter.map(_ => _.toLowerCase()) : [''];
    let allObjects = await getAllItemsOfCollection(RequestCollection);

    const getNestedValues = obj => {
      let result: string[] = [];
      for (const key of Object.keys(obj)) {
        const prop = obj[key];
        if (obj.hasOwnProperty(key) && prop) {
          if (typeof (prop) === 'object' && !Array.isArray(prop)) {
            result = result.concat(getNestedValues(prop));
          } else if (typeof (prop) === 'object' && Array.isArray(prop)) {
            for (const p of prop) {
              result = result.concat(getNestedValues(p));
            }
          } else if (typeof (prop) === 'string') {
            result.push(prop);
          }
        }
      }
      return result;
    };

    const filterResults = objs => {
      const result: any[] = [];
      for (const obj of objs) {
        const asText = getNestedValues(obj)
          .join('')
          .toLowerCase();
        for (let j = 0; j < filter.length; j++) {
          if (asText.indexOf(filter[j]) === -1) {
            break;
          }
          if (j === filter.length - 1) {
            result.push(obj._id);
          }
        }
      }
      return result;
    };

    switch (RequestCollection) {
      case 'digitalobject':
        await Promise.all(allObjects.map(async digObj => Mongo.resolve(digObj, 'digitalobject')));
        break;
      case 'model':
        allObjects = allObjects.filter(model =>
          model && model.finished && model.online
          && model.relatedDigitalObject && model.relatedDigitalObject['_id']);
        for (const obj of allObjects) {
          if (obj.relatedDigitalObject['_id']) {
            const tempDigObj =
              await Mongo.resolve(obj.relatedDigitalObject, 'digitalobject');
            obj.relatedDigitalObject = await Mongo.resolve(tempDigObj, 'digitalobject');
            obj.settings.preview = '';
          }
        }
        break;
      default:
    }

    response.send(filterResults(allObjects));
  },
};

Mongo.init()
  .catch(e => Logger.err(e));

export { Mongo };
