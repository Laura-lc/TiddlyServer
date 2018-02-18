import { StateObject, keys, ServerConfig, AccessPathResult, AccessPathTag, DebugLogger, PathResolverResult, } from "./server-types";
import { Observable } from "../lib/rx";

import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';

//import { TiddlyWiki } from 'tiddlywiki';
import { EventEmitter } from "events";
import { parse } from "url";
import { inspect } from "util";

var settings: ServerConfig = {} as any;

const debug = DebugLogger('DAT');

const loadedFolders: { [k: string]: FolderData | ([http.IncomingMessage, http.ServerResponse])[] } = {};
const otherSocketPaths: { [k: string]: WebSocket[] } = {};

import { tsloader } from './tsloader';

export function init(eventer: EventEmitter) {
    eventer.on('settings', function (set: ServerConfig) {
        settings = set;
    })
    eventer.on('websocket-connection', function (client: WebSocket, request: http.IncomingMessage) {
        let reqURL = parse(request.url as string);// new URL(request.url as string);
        let datafolder = loadedFolders[reqURL.pathname as string] as FolderData;
        debug([reqURL.pathname as string, !!datafolder].join(' '));
        if (!datafolder) {
            if (!otherSocketPaths[reqURL.pathname as string])
                otherSocketPaths[reqURL.pathname as string] = [];
            let other = otherSocketPaths[reqURL.pathname as string]
            other.push(client);
            client.addEventListener('message', event => {
                other.forEach(e => {
                    if (e === client) return;
                    e.send(event.data);
                })
            });
            client.addEventListener('error', (event) => {
                debug('WS-ERROR %s %s', reqURL.pathname, event.type)
                other.splice(other.indexOf(client), 1);
                client.close();
            });
            client.addEventListener('close', (event) => {
                debug('WS-CLOSE %s %s %s', reqURL.pathname, event.code, event.reason);
                other.splice(other.indexOf(client), 1);
            });
            return;
        }
        datafolder.sockets.push(client);

        client.addEventListener('message', (event) => {
            // const message = new WebSocketMessageEvent(event, client);
            // (datafolder.$tw.wss as WebSocket);
            // datafolder.$tw.hooks.invokeHook('th-websocket-message', event.data, client);
        })
        client.addEventListener('error', (event) => {
            debug('WS-ERROR %s %s', reqURL.pathname, event.type)
            datafolder.sockets.splice(datafolder.sockets.indexOf(client), 1);
            client.close();
        })
        client.addEventListener('close', (event) => {
            debug('WS-CLOSE %s %s %s', reqURL.pathname, event.code, event.reason);
            datafolder.sockets.splice(datafolder.sockets.indexOf(client), 1);
        })
    })
}

type FolderData = {
    $tw: any, //$tw.global,
    prefix: string,
    folder: string,
    server: any, //$tw.core.modules.commands.server.Server,
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    sockets: WebSocket[];
};

function quickArrayCheck(obj: any): obj is Array<any> {
    return typeof obj.length === 'number';
}

export function datafolder(result: PathResolverResult) {
    //warm the cache
    //require("tiddlywiki/boot/boot.js").TiddlyWiki();

    // Observable.of(result).mergeMap(res => {

    /**
     * reqpath  is the prefix for the folder in the folder tree
     * item     is the folder string in the category tree that reqpath led to
     * filepath is the path relative to them
     */
    let { state } = result;
    //get the actual path to the folder from filepath

    let filepathPrefix = result.filepathPortion.slice(0, state.statPath.index).join('/');
    //get the tree path, and add the file path (none if the tree path is a datafolder)
    let fullPrefix = ["", result.treepathPortion.join('/')];
    if (state.statPath.index > 0) fullPrefix.push(filepathPrefix);
    //join the parts and split into an array
    fullPrefix = fullPrefix.join('/').split('/');
    //use the unaltered path in the url as the tiddlywiki prefix
    let prefixURI = state.url.pathname.split('/').slice(0, fullPrefix.length).join('/');
    //get the full path to the folder as specified in the tree
    let folder = state.statPath.statpath;
    //initialize the tiddlywiki instance

    tsloader(state, prefixURI, folder);
    
    if (!loadedFolders[prefixURI] || state.url.query.reload === "true") {
        loadedFolders[prefixURI] = [];
        loadTiddlyWiki(prefixURI, folder);
    }

    const isFullpath = result.filepathPortion.length === state.statPath.index;
    //set the trailing slash correctly if this is the actual page load
    //redirect ?reload=true requests to the same, to prevent it being 
    //reloaded multiple times for the same page load.
    if (isFullpath && !settings.useTW5path !== !state.url.pathname.endsWith("/")
        || state.url.query.reload === "true") {
        let redirect = prefixURI + (settings.useTW5path ? "/" : "");
        state.res.writeHead(302, {
            'Location': redirect
        });
        state.res.end();
        // return Observable.empty();
    }
    //pretend to the handler like the path really has a trailing slash
    let req = new Object(state.req) as http.IncomingMessage;
    req.url += ((isFullpath && !state.url.path.endsWith("/")) ? "/" : "");
    // console.log(req.url);
    const load = loadedFolders[prefixURI];
    if (Array.isArray(load)) {
        load.push([req, state.res]);
    } else {
        load.handler(req, state.res);
    }
    // return Observable.empty<never>();
    // }).subscribe();
}

function loadTiddlyWiki(prefix: string, folder: string) {

    console.time('twboot-' + folder);
    // const dynreq = "tiddlywiki";
    DataFolder(prefix, folder, complete);

    function complete(err, $tw) {
        console.timeEnd('twboot-' + folder);
        if (err) {
            return doError(prefix, folder, err);
        }

        //we use $tw.modules.execute so that the module has its respective $tw variable.
        var serverCommand;
        try {
            serverCommand = $tw.modules.execute('$:/core/modules/commands/server.js').Command;
        } catch (e) {
            doError(prefix, folder, e);
            return;
        }
        var command = new serverCommand([], { wiki: $tw.wiki });
        var server = command.server;

        server.set({
            rootTiddler: "$:/core/save/all",
            renderType: "text/plain",
            serveType: "text/html",
            username: settings.username,
            password: "",
            pathprefix: prefix
        });
        //websocket requests coming in here will need to be handled 
        //with $tw.hooks.invokeHook('th-websocket-message', event);

        const requests = loadedFolders[prefix] as any[];
        const handler = server.requestHandler.bind(server);
        loadedFolders[prefix] = {
            $tw,
            prefix,
            folder,
            server,
            handler,
            sockets: []
        }
        $tw.hooks.addHook('th-websocket-broadcast', function (message, ignore) {
            let folder = loadedFolders[prefix] as FolderData;
            if (typeof message === 'object') message = JSON.stringify(message);
            else if (typeof message !== "string") message = message.toString();
            folder.sockets.forEach(client => {
                if (ignore.indexOf(client) > -1) return;
                client.send(message);
            })
        });
        //send the requests to the handler
        requests.forEach(e => {
            handler(e[0], e[1]);
        })
    }


};

function doError(prefix, folder, err) {
    debug(2, 'error starting %s at %s: %s', prefix, folder, err.stack);
    const requests = loadedFolders[prefix] as any[];
    loadedFolders[prefix] = {
        handler: function (req: http.IncomingMessage, res: http.ServerResponse) {
            res.writeHead(500, "TW5 data folder failed");
            res.write("The Tiddlywiki data folder failed to load. The error has been logged to the terminal. " +
                " To try again, use ?reload=true after making any necessary corrections.");
            res.end();
        }
    } as any;
    requests.forEach(([req, res]) => {
        (loadedFolders[prefix] as { handler: any }).handler(req, res);
    })

}

function DataFolder(prefix, folder, callback) {

    const $tw = require("../tiddlywiki/boot/boot.js").TiddlyWiki(
        require("../tiddlywiki/boot/bootprefix.js").bootprefix({
            packageInfo: JSON.parse(fs.readFileSync(path.join(__dirname, '../tiddlywiki/package.json'), 'utf8'))
        })
    );
    $tw.boot.argv = [folder];
    $tw.preloadTiddler({
        "text": "$protocol$//$host$" + prefix + "/",
        "title": "$:/config/tiddlyweb/host"
    });
	/**
	 * Specify the boot folder of the tiddlywiki instance to load. This is the actual path to the tiddlers that will be loaded 
	 * into wiki as tiddlers. Therefore this is the path that will be served to the browser. It will not actually run on the server
	 * since we load the server files from here. We only need to make sure that we use boot.js from the same version as included in 
	 * the bundle. 
	**/
    try {
        $tw.boot.boot(() => {
            callback(null, $tw);
        });
    } catch (err) {
        callback(err);
    }
}