import * as bodyParser from 'body-parser';
import * as compression from 'compression';
import * as cookieParser from 'cookie-parser';
import * as corser from 'corser';
import * as express from 'express';
import * as expressSession from 'express-session';
import { readFileSync } from 'fs';
import { copySync, ensureDirSync, pathExistsSync } from 'fs-extra';
import * as HTTP from 'http';
import * as HTTPS from 'https';
import * as passport from 'passport';
import * as LocalStrategy from 'passport-local';
import * as socketIo from 'socket.io';
import * as uuid from 'uuid';
import * as zlib from 'zlib';

import { RootDirectory } from '../environment';

import { Configuration as Conf } from './configuration';
import { Logger } from './logger';

const Express: any = {
  server: express(),
  passport,
  createServer: () => {
    if (Conf.Express.enableHTTPS) {
      const privateKey = readFileSync(Conf.Express.SSLPaths.PrivateKey);
      const certificate = readFileSync(Conf.Express.SSLPaths.Certificate);

      const options = { key: privateKey, cert: certificate };
      if (Conf.Express.SSLPaths.Passphrase && Conf.Express.SSLPaths.Passphrase.length > 0) {
        options['passphrase'] = Conf.Express.SSLPaths.Passphrase;
      }
      return HTTPS.createServer(options, Express.server);
    }
    return HTTP.createServer(Express.server);
  },
};

const Listener = Express.createServer();
const WebSocket = socketIo(Listener);
const Server: express.Application = Express.server;

Express.startListening = () => {
  Listener.listen(Conf.Express.Port, Conf.Express.Host);
  Logger.log(`HTTPS Server started and listening on port ${Conf.Express.Port}`);
};

// ExpressJS Middleware
// This turns request.body from application/json requests into readable JSON
Server.use(bodyParser.json({ limit: '50mb' }));
// Same for cookies
Server.use(cookieParser());
// Gzipping Middleware
Server.use(compression({
  strategy: zlib.Z_FILTERED,
  level: 9,
  memLevel: 9,
  windowBits: 15,
  chunkSize: 65536,
}));
// Enable CORS
// TODO: Find out which routes need CORS
Server.use(corser.create({
  supportsCredentials: true,
  /*origins: Conf.Express.OriginWhitelist,*/
  methods: corser.simpleMethods.concat(['PUT', 'OPTIONS']),
  requestHeaders: corser.simpleRequestHeaders
    .concat([
      'X-Requested-With',
      'Access-Control-Allow-Origin',
      'semirandomtoken',
      'relPath',
      'metadatakey',
      'prefix',
      'filetype']),
}));
// Static
const upDir = `${RootDirectory}/${Conf.Uploads.UploadDirectory}/`;
Server.use('/uploads', express.static(upDir));
Server.use('/previews', express.static(`${upDir}/previews`));

// Create preview directory and default preview file
ensureDirSync(`${RootDirectory}/${Conf.Uploads.UploadDirectory}/previews`);
if (!pathExistsSync(`${RootDirectory}/${Conf.Uploads.UploadDirectory}/previews/noimage.png`)) {
  copySync(
    `${RootDirectory}/assets/noimage.png`,
    `${RootDirectory}/${Conf.Uploads.UploadDirectory}/previews/noimage.png`);
}

// Passport
Express.passport.use(new LocalStrategy(
  (username, password, done) => done(null, { username, password })));

Express.passport.serializeUser((user: any, done) => done(undefined, user.username));
Express.passport.deserializeUser((id, done) => done(undefined, id));

Server.use(Express.passport.initialize());
Server.use(expressSession({
  genid: uuid,
  secret: Conf.Express.PassportSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: false,
    sameSite: false,
  },
}));
Server.use(Express.passport.session());

export { Express, Server, WebSocket };
