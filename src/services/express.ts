import * as bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { BinaryLike, createHmac, randomBytes } from 'crypto';
import express from 'express';
import expressSession from 'express-session';
import shrinkRay from 'shrink-ray-current';
import { readFileSync } from 'fs';
import { copySync, ensureDirSync, pathExistsSync } from 'fs-extra';
import * as HTTP from 'http';
import * as HTTPS from 'https';
import passport from 'passport';
import LdapStrategy from 'passport-ldapauth';
import { Strategy as LocalStrategy } from 'passport-local';
import SocketIo from 'socket.io';

import { RootDirectory } from '../environment';
import { IInvalid, IUserData, EUserRank } from '../interfaces';

import { Configuration as Conf } from './configuration';
import { Logger } from './logger';
import { Mongo } from './mongo';
import { serveFile } from './dynamic-compression';

const Server = express();
const createServer = () => {
  if (Conf.Express.enableHTTPS) {
    const privateKey = readFileSync(Conf.Express.SSLPaths.PrivateKey);
    const certificate = readFileSync(Conf.Express.SSLPaths.Certificate);

    const options = { key: privateKey, cert: certificate };
    if (
      Conf.Express.SSLPaths.Passphrase &&
      Conf.Express.SSLPaths.Passphrase.length > 0
    ) {
      (options as any)['passphrase'] = Conf.Express.SSLPaths.Passphrase;
    }
    return HTTPS.createServer(options, Server);
  }
  return HTTP.createServer(Server);
};

const getLDAPConfig: LdapStrategy.OptionsFunction = (_request, callback) => {
  if (!Conf.Express.LDAP) {
    Logger.warn('LDAP not configured but strategy was called');
    callback('LDAP not configured', {
      server: {
        url: '',
        searchBase: '',
        searchFilter: '',
      },
    });
  } else {
    const request = _request as express.Request;
    const DN = Conf.Express.LDAP.DNauthUID
      ? `uid=${request.body.username},${Conf.Express.LDAP.DN}`
      : Conf.Express.LDAP.DN;
    callback(undefined, {
      server: {
        url: Conf.Express.LDAP.Host,
        bindDN: DN,
        bindCredentials: `${request.body.password}`,
        searchBase: Conf.Express.LDAP.searchBase,
        searchFilter: `(uid=${request.body.username})`,
        reconnect: true,
      },
    });
  }
};

const startListening = () => {
  Listener.listen(Conf.Express.Port, Conf.Express.Host);
  Logger.log(`HTTPS Server started and listening on port ${Conf.Express.Port}`);
};

const authenticate = (options: { session: boolean } = { session: false }) =>
  passport.authenticate(['local', 'ldapauth'], { session: options.session });

const Listener = createServer();
const WebSocket = SocketIo(Listener);

// ExpressJS Middleware
// Enable CORS
// TODO: Find out which routes need CORS
Server.use(
  '*',
  cors({
    origin: true,
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE'.split(','),
    allowedHeaders: [
      'X-Requested-With',
      'Access-Control-Allow-Origin',
      'content-type',
      'semirandomtoken',
      'relPath',
      'metadatakey',
      'prefix',
      'filetype',
    ],
  }),
);
// This turns request.body from application/json requests into readable JSON
Server.use(bodyParser.json({ limit: '50mb' }));
// Same for cookies
Server.use(cookieParser());
// Compression: Brotli -> Fallback GZIP
Server.use(shrinkRay());
// Static
const upDir = `${RootDirectory}/${Conf.Uploads.UploadDirectory}/`;
//Server.use('/uploads', express.static(upDir));
Server.use('/uploads', serveFile(upDir));
Server.use('/previews', express.static(`${upDir}/previews`));

// Create preview directory and default preview file
ensureDirSync(`${RootDirectory}/${Conf.Uploads.UploadDirectory}/previews`);
if (
  !pathExistsSync(
    `${RootDirectory}/${Conf.Uploads.UploadDirectory}/previews/noimage.png`,
  )
) {
  copySync(
    `${RootDirectory}/assets/noimage.png`,
    `${RootDirectory}/${Conf.Uploads.UploadDirectory}/previews/noimage.png`,
  );
}

// Passport
passport.use(
  new LdapStrategy(
    getLDAPConfig,
    (user: any, done: any): LdapStrategy.VerifyCallback => {
      const adjustedUser = {
        fullname: user['cn'],
        prename: user['givenName'],
        surname: user['sn'],
        mail: user['mail'],
        role: EUserRank.user,
      };
      return done(undefined, adjustedUser);
    },
  ),
);

passport.use(
  new LocalStrategy((username: string, password: string, done: any) => {
    const coll = Mongo.getAccountsRepository().collection('users');
    coll.findOne({ username }, async (err, user) => {
      if (err) return done(err);
      if (!user) return done(undefined, false);
      if (!(await verifyUser(username, password)))
        return done(undefined, false);
      return done(undefined, user);
    });
  }),
);

passport.serializeUser((user: any, done) => {
  const serialValue = Object.keys(user)
    .reduce((acc, val) => `${acc}${val}${user[val]}`, '')
    .replace(/[.]*[_]*[-]*/g, '');
  done(undefined, serialValue);
});
passport.deserializeUser((id, done) => done(undefined, id));

// Local Auth Registration, Salting and Verification
const generateSalt = (length = 16) => {
  // tslint:disable-next-line
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);
};
const sha512 = (password: string, salt: BinaryLike) => {
  const hash = createHmac('sha512', salt);
  hash.update(password);
  const passwordHash = hash.digest('hex');
  return { salt, passwordHash };
};
const SALT_LENGTH = 16;
const saltHashPassword = (password: string) => {
  return sha512(password, generateSalt(SALT_LENGTH));
};

const registerUser = async (
  request: express.Request,
  response: express.Response,
): Promise<any> => {
  const coll = Mongo.getAccountsRepository().collection('users');
  const passwords = Mongo.getAccountsRepository().collection('passwords');

  const isUser = (obj: any): obj is IUserData => {
    const person = obj as IUserData | IInvalid;
    return (
      person &&
      person.fullname !== undefined &&
      person.prename !== undefined &&
      person.surname !== undefined &&
      person.mail !== undefined &&
      person.username !== undefined &&
      (person as any)['password'] !== undefined
    );
  };

  // First user gets admin
  const isFirstUser = (await coll.findOne({})) === null;
  const role = isFirstUser ? EUserRank.admin : EUserRank.user;

  const user = request.body as IUserData & { password: string };
  const adjustedUser = { ...user, role, data: {} };
  const userExists = (await coll.findOne({ username: user.username })) !== null;
  if (userExists) {
    return response.send({ status: 'error', message: 'User already exists' });
  }
  if (isUser(adjustedUser)) {
    // tslint:disable-next-line
    delete adjustedUser['password'];
    await passwords
      .updateOne(
        { username: user.username },
        {
          $set: {
            username: user.username,
            password: saltHashPassword(user.password),
          },
        },
        { upsert: true },
      )
      .then()
      .catch();
    coll
      .insertOne(adjustedUser)
      .then(() => response.send({ status: 'ok', message: 'Registered' }))
      .catch(() =>
        response.send({ status: 'error', message: 'Failed inserting user' }),
      );
  } else {
    response.send({ status: 'error', message: 'Incomplete user data' });
  }
};

const verifyUser = async (username: string, password: string) => {
  const coll = Mongo.getAccountsRepository().collection('users');
  const passwords = Mongo.getAccountsRepository().collection('passwords');
  const userInDB = await coll.findOne({ username });
  if (!userInDB) return false;
  const pwOfUser = await passwords.findOne({ username });
  if (!pwOfUser) return false;
  const salt = pwOfUser.password.salt;
  const hash = pwOfUser.password.passwordHash;
  const newHash = sha512(password, salt).passwordHash;
  return newHash === hash;
};

Server.use(passport.initialize());

const UUID_LENGTH = 64;
const genid = () => randomBytes(UUID_LENGTH).toString('hex');

Server.use(
  expressSession({
    genid,
    secret: Conf.Express.PassportSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: false,
      sameSite: false,
    },
  }),
);
Server.use(passport.session());

const Express = {
  Server,
  passport,
  createServer,
  getLDAPConfig,
  startListening,
  authenticate,
  registerUser,
};

export { Express, Server, WebSocket };
