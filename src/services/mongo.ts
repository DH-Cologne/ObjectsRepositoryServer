/**
 * Imported external configuration
 * MongoClient is the main way to connect to a MongoDB server
 * ObjectId is the type & constructor of a MongoDB unique identifier
 */
import { MongoClient, ObjectId } from 'mongodb';
import { Configuration } from './configuration';

/**
 * Imported for detailed logging
 */
import { Verbose } from '../environment';
import { inspect as InspectObject } from 'util';

/** Interfaces */
import { Compilation } from '../interfaces/compilation.interface';
import { Model } from '../interfaces/model.interface';

/**
 * Object containing variables which define an established connection
 * to a MongoDB Server specified in Configuration
 * @type {Object}
 */
const Mongo = {
    Client: undefined,
    Connection: undefined,
    DBObjectsRepository: undefined,
    Retry: 0,
    MaxRetries: 10,
    ReconnectInterval: undefined,
    /**
     * Initialize a MongoDB Client
     * uses hostname and port defined in Configuration file
     */
    initClient: () => {
        this.Client = new MongoClient(`mongodb://${Configuration.Mongo.Hostname}:${Configuration.Mongo.Port}/`, { useNewUrlParser: true });
    },
    /**
     * Make sure our predefined collections exist in the Database
     */
    initCollections: () => {
        this.Connection.then(() => {
            Configuration.Mongo.Databases.ObjectsRepository.Collections.forEach(collection => {
                this.DBObjectsRepository.createCollection(collection.toLowerCase());
            });
        });
    },
    /**
     * Establish connection to the server
     * Saving this as a variable allows re-using the same connection
     * This reduces latency on all calls
     * TODO: If the connection closes, re-open it
     */
    establishConnection: () => {
        this.Connection = this.Client.connect();
    },
    initReconnect: () => {
        this.Connection.then(() => {
            this.DBObjectsRepository.on('close', () => {
                console.log('Connection closed. Retrying...');
                setTimeout(() => {
                    Mongo.Connection = undefined;
                    Mongo.ReconnectInterval = setInterval(() => {
                        if (Mongo.Connection === undefined) {
                            Mongo.Retry++;
                            if (Mongo.Retry <= Mongo.MaxRetries) {
                                Mongo.establishConnection();
                            } else {
                                console.log(`Reconnect failed after ${Mongo.MaxRetries} tries`);
                                Mongo.ReconnectInterval = undefined;
                                Mongo.Retry = 0;
                            }
                        } else {
                            console.log('Reconnected!');
                            Mongo.ReconnectInterval = undefined;
                            Mongo.Retry = 0;
                        }
                    }, 1000);
                }, 1000);
            });
        });
    },
    /**
     * Save the most used Database as a variable
     * to reduce the amount of calls needed
     */
    initObjectsRepository: () => {
        this.Connection.then(() => {
            this.DBObjectsRepository = this.Client.db(Configuration.Mongo.Databases.ObjectsRepository.Name);
        });
    },
    /**
     * When the user submits the metadataform this function
     * adds the missing data to defined collections
     */
    submit: (request, response) => {
        this.Connection.then(async () => {
            if (Verbose) {
                console.log('VERBOSE: Handling submit request');
                console.log(InspectObject(request.body));
            }

            const resultObject = request.body;

            /**
             * Adds data {field} to a collection {collection}
             * and returns the {_id} of the created object.
             * If {field} already has an {_id} property the server
             * will assume the object already exists in the collection
             * and instead return the existing {_id}
             */
            const addAndGetId = async (field, collection) => {
                return (field['_id'] !== undefined && field['_id'].length > 0) ?
                    String(field['_id']) :
                    await this.DBObjectsRepository.collection(collection).insertOne(field).then(result => {
                        return String(result.ops[0]['_id']);
                    });
            };

            /**
             * Use addAndGetId function on all Arrays containing
             * data that need to be added to collections
             */

            // TODO: Eleganter lösen
            resultObject['contact_person'] = await Promise.all(
                resultObject['contact_person'].map(async person => addAndGetId(person, 'person')));

            resultObject['digobj_rightsowner_person'] = await Promise.all(
                resultObject['digobj_rightsowner_person'].map(async person => addAndGetId(person, 'person')));

            resultObject['digobj_person'] = await Promise.all(
                resultObject['digobj_person'].map(async person => addAndGetId(person, 'person')));

            resultObject['digobj_rightsowner_institution'] = await Promise.all(
                resultObject['digobj_rightsowner_institution'].map(async institution => addAndGetId(institution, 'institution')));

            /*
            resultObject['digobj_tags'] = await Promise.all(
                resultObject['digobj_tags'].map(async tag => addAndGetId(tag, 'tag')));
            */


            if (Verbose) {
                console.log('VERBOSE: Finished Object');
                console.log(InspectObject(resultObject));
            }

            response.send(resultObject);
        });
    },
    /**
     * Express HTTP POST request
     * Handles a single document that needs to be added
     * to our Database
     * request.body is any JavaScript Object
     * On success, sends a response containing the added Object
     */
    addToObjectCollection: (request, response) => {
        this.Connection.then(async () => {
            const RequestCollection = request.params.collection.toLowerCase();

            if (Verbose) {
                console.log('VERBOSE: Adding the following document to collection ' + RequestCollection);
                console.log(RequestCollection);
                console.log(InspectObject(request.body));
            }

            const collection = this.DBObjectsRepository.collection(RequestCollection);

            const addAndGetId = async (field, add_to_coll) => {
                return {
                    '_id': (field['_id'] !== undefined && field['_id'].length > 0) ?
                        String(field['_id']) :
                        await this.DBObjectsRepository.collection(add_to_coll).insertOne(field).then(result => {
                            return String(result.ops[0]['_id']);
                        })
                };
            };

            switch (RequestCollection) {
                case 'compilation':
                    const resultObject = request.body;


                    const bExists = new Promise<any>((resolve, reject) => {
                        collection.findOne({ '_id': resultObject._id }, (db_error, result) => {
                            resolve(result);
                        });
                    });

                    await bExists.then(async (result) => {
                        // Add models in models Array to model collection and return their ObjectId
                        resultObject['models'] = await Promise.all(
                            resultObject['models'].map(async model => addAndGetId(model, 'model')));

                        // Result will be null if no compilation with the ObjectId exists
                        if (result === null) {
                            // Add new compilation
                            collection.insertOne(resultObject, (db_error, db_result) => {
                                response.send(db_result.ops);

                                if (Verbose) {
                                    console.log('VERBOSE: Success! Added the following');
                                    console.log(db_result.ops);
                                }
                            });
                        } else {
                            // Update compilation
                            // Only models will be updated
                            const updateArray = [];
                            resultObject['models'].map(model => updateArray.push(model));
                            collection.findOneAndUpdate(
                                { '_id': resultObject._id },
                                { $push: { models: { $each: updateArray } } },
                                (db_error, db_result) => {
                                    response.send(db_result);

                                    if (Verbose) {
                                        console.log('VERBOSE: Success! Added the following');
                                        console.log(db_result);
                                    }
                                }
                            );
                        }
                    }).catch(error => {
                        console.log(error);
                        response.send(error);
                    });


                    break;

                default:
                    collection.insertOne(request.body, (db_error, result) => {
                        response.send(result.ops);

                        if (Verbose) {
                            console.log('VERBOSE: Success! Added the following');
                            console.log(result.ops);
                        }
                    });
                    break;
            }
        });
    },
    /**
     * Express HTTP POST request
     * Handles multiple documents that need to be added
     * to our Database
     * request.body is any Array of JavaScript Objects
     * On success, sends a response containing the added Array
     */
    addMultipleToObjectCollection: (request, response) => {
        this.Connection.then(() => {
            if (Verbose) {
                console.log('VERBOSE: Adding the following document to collection ' + request.params.collection);
                console.log(request.params.collection.toLowerCase());
                console.log(InspectObject(request.body));
            }

            const collection = this.DBObjectsRepository.collection(request.params.collection.toLowerCase());

            collection.insertMany(request.body, (db_error, result) => {
                response.send(result.ops);
                if (Verbose) {
                    console.log('VERBOSE: Success! Added the following');
                    console.log(result.ops);
                }
            });
        });
    },
    /**
     * TODO: Handle user accounts
     */
    addToAccounts: (collection, data) => {

    },
    /**
     * Express HTTP POST request
     * Finds a model by it's ObjectId and
     * updates it's preview screenshot
     */
    updateScreenshot: (request, response) => {
        this.Connection.then(() => {
            if (Verbose) {
                console.log('VERBOSE: Updating preview screenshot for model with identifier: ' + request.params.identifier);
            }

            const collection = this.DBObjectsRepository.collection('model');

            collection.findOneAndUpdate(
                { '_id': ObjectId(request.params.identifier) },
                { $set: { preview: request.body.data } },
                (db_error, result) => {
                    console.log(result);
                    response.send(result);
                });
        });
    },
    /**
     * Resolve compilation
     * Iterates through the ObjectIds of a compilation
     * and inserts the data associated with those ObjectIds
     */
    resolveCompilation: async (identifier, collection_name) => {
        if (Verbose) {
            console.log('VERBOSE: Resolving compilation');
        }
        const resolve_collection = this.DBObjectsRepository.collection(collection_name);
        return await resolve_collection.findOne({ '_id': ObjectId(identifier) }).then((resolve_result) => resolve_result);
    },
    /**
     * Express HTTP GET request
     * Finds any document in any collection by its MongoDB identifier
     * On success, sends a response containing the Object
     * TODO: Handle No Objects found?
     */
    getFromObjectCollection: (request, response) => {
        this.Connection.then(async () => {
            const RequestCollection = request.params.collection.toLowerCase();

            const collection = this.DBObjectsRepository.collection(RequestCollection);

            const searchParameter = { '_id': request.params.identifier };

            switch (RequestCollection) {
                case 'compilation':
                    collection.findOne(searchParameter).then(async (result: Compilation) => {
                        result.models = await Promise.all(result.models.map(async (model) =>
                            await this.resolveCompilation(model._id, 'model')));
                        response.send(result);
                    }).catch((db_error) => {
                        console.error(db_error);
                        response.sendStatus(400);
                    });

                    break;
                default:
                    collection.findOne(searchParameter, (db_error, result) => {
                        response.send(result);
                    });
                    break;
            }
        });
    },
    /**
     * Express HTTP GET request
     * Finds all documents in any collection
     * On success, sends a response containing an Array
     * of all Objects in the specified collection
     * TODO: Handle No Objects found?
     */
    getAllFromObjectCollection: (request, response) => {
        this.Connection.then(() => {
            const RequestCollection = request.params.collection.toLowerCase();

            const collection = this.DBObjectsRepository.collection(RequestCollection);

            switch (RequestCollection) {
                case 'compilation':
                    collection.find({}).toArray(async (db_error, results) => {
                        results = await results.map(result =>
                            Promise.all(result.models.map(async (model) => await this.resolveCompilation(model._id, 'model'))));
                        response.send(results);
                    });
                    break;

                default:
                    collection.find({}).toArray((db_error, result) => {
                        response.send(result);
                    });
                    break;
            }
        });
    }
};

const ReconnectProxy = new Proxy(Mongo, {
    get(target, property, receiver) {
        console.log(target);
        console.log(property);
        console.log(receiver);
        return target[property];
    }
});

/**
 * Initialization
 */
Mongo.initClient();
Mongo.establishConnection();
Mongo.initObjectsRepository();
Mongo.initCollections();
Mongo.initReconnect();

export { Mongo };
