//-------------------------------------------------------------------------------
// Copyright IBM Corp. 2015
//
// Licensed under the Apache License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//-------------------------------------------------------------------------------

'use strict';

var util = require('util');

var pipesSDK = require('simple-data-pipe-sdk');
var connectorExt = pipesSDK.connectorExt;

var bluemixHelperConfig = require.main.require('bluemix-helper-config');
var global = bluemixHelperConfig.global;

var runkeeper = require('runkeeper-js');

// Runkeeper client options.
// Client ID/Secret and AccessToken will be set by the data pipe.
// See https://github.com/mko/runkeeper-js for more information.
var runkeeperClientOptions = {
	client_id : '', /* will be set by sdp */
	client_secret : '', /* will be set by sdp */
	auth_url : 'https://runkeeper.com/apps/authorize',
	access_token_url : 'https://runkeeper.com/apps/token',
	redirect_uri : '',
	access_token : '', /* will be set by sdp */
	api_domain : 'api.runkeeper.com'
};

// Default Runkeeper URIs - these can change and must be queried using the Runkeeper user API.
// See https://runkeeper.com/developer/healthgraph/overview for more information.
var runkeeperUris = {
	settings: '/settings',
	records: '/records',
	profile: '/profile',
	change_log: '/changeLog',
	strength_training_activities: '/strengthTrainingActivities',
	weight: '/weight',
	fitness_activities: '/fitnessActivities',
	background_activities: '/backgroundActivities',
	team: '/team',
	sleep: '/sleep',
	nutrition: '/nutrition',
	general_measurements: '/generalMeasurements',
	diabetes: '/diabetes'
};

// Wrapper to make Runkeeper API calls using OAuth2.0.
// See https://github.com/mko/runkeeper-js for more information.
var runkeeperClient = new runkeeper.HealthGraph(runkeeperClientOptions);

// Passport strategy for Runkeeper.
// See https://github.com/jaredhanson/passport-runkeeper for more information.
var dataSourcePassportStrategy = require('passport-runkeeper').Strategy;

/**
 * Connector that retrieves JSON records from Runkeeper and stores them in Cloudant.
 */
function oAuthRunkeeperConnector( parentDirPath ){

	var connectorInfo = {
		id: require('../package.json').simple_data_pipe.name,
		name: 'Runkeeper'
	};

	var connectorOptions = {
		recreateTargetDb: true, // if set (default: false) all data currently stored in the staging database is removed prior to data load
		useCustomTables: true   // keep true (default: false)
	};						

	// Call constructor from super class; 
	connectorExt.call(this, 
		connectorInfo.id, 			
		connectorInfo.name, 
		connectorOptions	  
	);	

	// writes to the application's global log file
	var globalLog = this.globalLog;

	/**
	 * Define the passport strategy to use for oAuth authentication with the data source
	 * @param pipe - data pipe configuration, containing the user-provided oAuth client id and client secret
	 * @returns a passport strategy for this data source
	 */
	this.getPassportStrategy = function(pipe) {

		return new dataSourcePassportStrategy({
			clientID: pipe.clientId,											 // mandatory; oAuth client id; do not change
			clientSecret: pipe.clientSecret,									 // mandatory; oAuth client secret;do not change
			callbackURL: global.getHostUrl() + '/authCallback' 					 // mandatory; oAuth callback; do not change
		  },
		  function(accessToken, refreshToken, profile, done) {					 // Passport verify callback; customize signature as needed

		  	globalLog.debug('User was authenticated successfully. Profile information: ' + util.inspect(profile,3));

			  process.nextTick(function () {

				// Mandatory; attach the obtained access token to the user profile
				// Mandatory, if applicable; also attach the obtained refresh token to the user profile
				// the user profile is passed as a parameter to authCallback()
				profile.oauth_access_token = accessToken;
		        
				profile.oauth_refresh_token = refreshToken;

				return done(null, profile);
			  });
		  }
		);
	};

	/**
	 * passportAuthCallbackPostProcessing: post processing for OAuth authentication protocol
	 * Stores accessToken + refreshToken and retrieves list of available 'tables' (Runkeeper resources) that can be moved by the pipe
	 * @param profile - the output generated by the passport verify callback
	 * @param pipe - data pipe configuration
	 * @param callback(err, pipe ) error information in case of a problem or the updated pipe
	 */
	this.passportAuthCallbackPostProcessing = function(profile, pipe, callback) {

		pipe.oAuth = {
			accessToken : profile.oauth_access_token,
			refreshToken: profile.oauth_refresh_token
		};

		// Fetch list of data sets that the user can choose from; the list is displayed in the Web UI in the 'Filter Data' panel.
		// Attach data set list to the pipe configuration
		this.getRunkeeperDataSetList(pipe, function (err, pipe){
			if(err) {
		    	globalLog.error('OAuth post processing failed. The Runkeeper data set list could not be created for data pipe configuration ' + pipe._id + ': ' + err);
		    }	
		    else {
			    globalLog.debug('OAuth post processing completed. Data pipe configuration was updated: ');
			    globalLog.debug(' ' + util.inspect(pipe,3));
		    }	

			return callback(err, pipe);
		});		

	}; // authCallback

	/**
	 * Returns the list of Runkeeper resources available to the data pipe.
	 * @param {Object} pipe - Data pipe configuration
	 * @param {callback} done - invoke after processing is complete or has resulted in an error; parameters (err, updated_pipe)
	 * @return list of data sets (also referred to as tables for legacy reasons) from which the user can choose from
	 */
	this.getRunkeeperDataSetList = function(pipe, done) {

		var dataSets = [];
		dataSets.push({name:'settings', label:'Settings', description : ''});
		dataSets.push({name:'records', label:'Records', description : ''});
		dataSets.push({name:'profile', label:'Profile', description : ''});
		dataSets.push({name:'change_log', label:'Change Log', description : ''});
		dataSets.push({name:'strength_training_activities', label:'Strength Training Activities', description : ''});
		dataSets.push({name:'weight_measurements', label:'Weight Measurements', description : ''});
		dataSets.push({name:'fitness_activities', label:'Fitness Activities', description : ''});
		dataSets.push({name:'background_activities', label:'Background Activities', description : ''});
		dataSets.push({name:'friends', label:'Friends', description : ''});
		dataSets.push({name:'sleep_measurements', label:'Sleep Measurements', description : ''});
		dataSets.push({name:'nutritional_measurements', label:'Nutritional Measurements', description : ''});
		dataSets.push({name:'general_measurements', label:'General Measurements', description : ''});
		dataSets.push({name:'diabetes_measurements', label:'Diabetes Measurements', description : ''});
		// Provide the user with the option to load all data sets concurrently
		// by defining a single data set that contains only property 'labelPlural'
		dataSets.push({labelPlural:'All data sets'});

		// In the UI the user gets to choose from: 
		//  -> All data sets
		//  -> sample data set 1
		//  -> ...

		// sort data set list (if present, the ALL_DATA option should be displayed first)
		// attach data set list to data pipe configuration document
		pipe.tables =  dataSets.sort(function (dataSet1, dataSet2) {
			if(! dataSet1.name)	{ // ALL_DATA (only property labelPlural is defined)
				return -1;
			}
			if(! dataSet2.name) {// ALL_DATA (only property labelPlural is defined)
				return 1;
			}
			return dataSet1.label.localeCompare(dataSet2.label);
		});

		return done(null, pipe);

	}; // getTables


	/*
	 * ---------------------------------------------------------------------------------------
	 * Override general connector methods:
	 *  - doConnectStep: verify that OAuth information is still valid
	 *  - fetchRecords:  load data from data source
	 * ---------------------------------------------------------------------------------------
	 */

	/**
	* During data pipe runs, this method is invoked first.
	* Call the Runkeeper.user API to retrieve the URIs for all other resources.
	* @param done - callback that must be called when the connection is established
	* @param pipeRunStep - the current pipe step being executed
	* @param pipeRunStats - maintains pipe run stats such as startTime, # of records processed, etc
	* @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	* @param pipe - data pipe configuration
	* @param pipeRunner - executes the process of starting, running, and finishing the data pipe
	*/
	this.doConnectStep = function(done, pipeRunStep, pipeRunStats, pipeRunLog, pipe, pipeRunner) {
		// initialize the runkeeper client
		if(pipe) {
			runkeeperClient.client_id = pipe.clientId;
			runkeeperClient.client_secret = pipe.clientSecret;
			runkeeperClient.access_token = pipe.oAuth.accessToken;
			// call runkeeperClient.user to retrieve the URIs for all functions
			// these URIs can change and applications are required to use the URIs returned from this call
			// see https://runkeeper.com/developer/healthgraph/overview for more information
			pipeRunLog.info('Fetching Runkeeper URIs.');
			runkeeperClient.user(function(err, reply) {
				if(err) {
					pipeRunLog.error('Error fetching user from Runkeeper: ' + err);
					pipeRunLog.error('FFDC: Runkeeper client params: ');
					pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
					pipeRunLog.error('FFDC: Runkeeper reply for user request: ');
					pipeRunLog.error(' ' + util.inspect(reply,3));
					done(err);
				}
				else {
					if (reply) {
						if (reply.settings) {
							runkeeperUris.settings = reply.settings;
						}
						if (reply.records) {
							runkeeperUris.records = reply.records;
						}
						if (reply.profile) {
							runkeeperUris.profile = reply.profile;
						}
						if (reply.change_log) {
							runkeeperUris.change_log = reply.change_log;
						}
						if (reply.strength_training_activities) {
							runkeeperUris.strength_training_activities = reply.strength_training_activities;
						}
						if (reply.weight) {
							runkeeperUris.weight = reply.weight;
						}
						if (reply.fitness_activities) {
							runkeeperUris.fitness_activities = reply.fitness_activities;
						}
						if (reply.background_activities) {
							runkeeperUris.background_activities = reply.background_activities;
						}
						if (reply.team) {
							runkeeperUris.team = reply.team;
						}
						if (reply.sleep) {
							runkeeperUris.sleep = reply.sleep;
						}
						if (reply.nutrition) {
							runkeeperUris.nutrition = reply.nutrition;
						}
						if (reply.general_measurements) {
							runkeeperUris.general_measurements = reply.general_measurements;
						}
						if (reply.diabetes) {
							runkeeperUris.diabetes = reply.diabetes;
						}
					}
					done();
				}
			});
		}
		else {
			runkeeperClient = null;
			done();
		}
	}; // doConnectStep

	/**
	 * Fetch Runkeeper data to store in Cloudant.
	 * @param dataSet - dataSet.name contains the data set name that was (directly or indirectly) selected by the user
	 * @param done(err) - callback funtion to be invoked after processing is complete (or a fatal error has been encountered)
	 * @param pipe - data pipe configuration
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 */
	this.fetchRecords = function(dataSet, pushRecordFn, done, pipeRunStep, pipeRunStats, pipeRunLog, pipe, pipeRunner) {

		// The data set is typically selected by the user in the 'Filter Data' panel during the pipe configuration step
		// dataSet: {name: 'data set name'}. However, if you enabled the ALL option (see get Tables) and it was selected, 
		// the fetchRecords function is invoked asynchronously once for each data set.

		// Bunyan logging - https://github.com/trentm/node-bunyan
		// The log file is attached to the pipe run document, which is stored in the Cloudant repository database named pipes_db.
		// To enable debug logging, set environment variable DEBUG to '*'' or 'to sdp-pipe-run' (without the quotes).
		pipeRunLog.info('Fetching data set ' + dataSet.name + ' from runkeeper.');

		// call the appropriate function to retrieve data from Runkeeper
		// the called function will call done when complete
		switch(dataSet.name) {
			case 'settings' :
				getSettings(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'records' :
				getRecords(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'profile' :
				getProfile(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'change_log' :
				getChangeLog(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'strength_training_activities' :
				getStrengthTrainingActivities(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'weight_measurements' :
				getWeightMeasurements(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'fitness_activities' :
				getFitnessActivities(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'background_activities' :
				getBackgroundActivities(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'friends' :
				getFriends(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'sleep_measurements' :
				getSleepMeasurements(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'nutritional_measurements' :
				getNutritionalMeasurements(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'general_measurements' :
				getGeneralMeasurements(pushRecordFn, pipeRunLog, pipe, done);
				break;
			case 'diabetes_measurements' :
				getDiabetesMeasurements(pushRecordFn, pipeRunLog, pipe, done);
				break;
			default:
				pipeRunLog.error('This runkeeper connector cannot process data set ' + dataSet.name);
				done();
		}

	}; // fetchRecords

	/**
	 * Prefix Cloudant databases with connector id.
	 */
	this.getTablePrefix = function() {
		// The prefix is used to generate names for the Cloudant staging databases that hold your data. The recommended
		// value is the connector ID to assure uniqueness.
		return connectorInfo.id;
	};

	/**
	 * Fetch the user's settings from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/settings} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 */
	var getSettings = function(pushRecordFn, pipeRunLog, pipe, done) {
		pipeRunLog.info('Fetching settings.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.Settings+json', runkeeperUris.settings, function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching settings from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for settings request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				if (reply) {
					pipeRunLog.info('Fetched settings.');
					pushRecordFn(reply);
				}
				done();
			}
		});
	};

	/**
	 * Fetch the user's personal records from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/records} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 */
	var getRecords = function(pushRecordFn, pipeRunLog, pipe, done) {
		pipeRunLog.info('Fetching records.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.Records+json', runkeeperUris.records, function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching records from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for records request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				if (reply) {
					pipeRunLog.info('Fetched ' + reply.length + ' records.');
					pushRecordFn(reply);
				}
				done();
			}
		});
	};

	/**
	 * Fetch the user's profile from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/profile} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 */
	var getProfile = function(pushRecordFn, pipeRunLog, pipe, done) {
		pipeRunLog.info('Fetching profile.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.Profile+json', runkeeperUris.profile, function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching profile from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for profile request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				if (reply) {
					pipeRunLog.info('Fetched profile.');
					pushRecordFn(reply);
				}
				done();
			}
		});
	};

	/**
	 * Fetch the user's change log from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/change-log} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 */
	var getChangeLog = function(pushRecordFn, pipeRunLog, pipe, done) {
		pipeRunLog.info('Fetching change log.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.ChangeLog+json', runkeeperUris.change_log, function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching change log from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for change log request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				if (reply) {
					pipeRunLog.info('Fetched change log.');
					pushRecordFn(reply);
				}
			}
			done();
		});
	};

	/**
	 * Fetch the user's strength training activities from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/strength-training} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 * @param [uri] - optional URI, used for paging. if not specified the default URI will be used
	 */
	var getStrengthTrainingActivities = function(pushRecordFn, pipeRunLog, pipe, done, uri) {
		pipeRunLog.info('Fetching strength training activities.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.StrengthTrainingActivityFeed+json', (uri||runkeeperUris.strength_training_activities), function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching strength training activities from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for strength training activities request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				var complete = true;
				if (reply && reply.items) {
					pipeRunLog.info('Fetched ' + reply.items.length + ' strength training activity(s).');
					pushRecordFn(reply.items);
					if (reply.next) {
						complete = false;
						getStrengthTrainingActivities(pushRecordFn, pipeRunLog, pipe, done, reply.next);
					}
				}
				if (complete) {
					done();
				}
			}
		});
	};

	/**
	 * Fetch the user's weight measurements from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/weight-sets} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 * @param [uri] - optional URI, used for paging. if not specified the default URI will be used
	 */
	var getWeightMeasurements = function(pushRecordFn, pipeRunLog, pipe, done, uri) {
		pipeRunLog.info('Fetching weight measurements.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.WeightSetFeed+json', (uri||runkeeperUris.weight), function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching weight measurements from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for weight measurements request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				var complete = true;
				if (reply && reply.items) {
					pipeRunLog.info('Fetched ' + reply.items.length + ' weight measurement(s).');
					pushRecordFn(reply.items);
					if (reply.next) {
						complete = false;
						getWeightMeasurements(pushRecordFn, pipeRunLog, pipe, done, reply.next);
					}
				}
				if (complete) {
					done();
				}
			}
		});
	};

	/**
	 * Fetch the user's fitness activities from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/fitness-activities} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 * @param [uri] - optional URI, used for paging. if not specified the default URI will be used
	 */
	var getFitnessActivities = function(pushRecordFn, pipeRunLog, pipe, done, uri) {
		pipeRunLog.info('Fetching fitness activities.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.FitnessActivityFeed+json', (uri||runkeeperUris.fitness_activities), function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching fitness activities from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for fitness activities request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				var complete = true;
				if (reply && reply.items) {
					pipeRunLog.info('Fetched ' + reply.items.length + ' fitness activity(s).');
					pushRecordFn(reply.items);
					if (reply.next) {
						complete = false;
						getFitnessActivities(pushRecordFn, pipeRunLog, pipe, done, reply.next);
					}
				}
				if (complete) {
					done();
				}
			}
		});
	};

	/**
	 * Fetch the user's background activities from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/background-activity-sets} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 * @param [uri] - optional URI, used for paging. if not specified the default URI will be used
	 */
	var getBackgroundActivities = function(pushRecordFn, pipeRunLog, pipe, done, uri) {
		pipeRunLog.info('Fetching background activities.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.BackgroundActivityFeed+json', (uri||runkeeperUris.background_activities), function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching background activities from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for background activities request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				var complete = true;
				if (reply && reply.items) {
					pipeRunLog.info('Fetched ' + reply.items.length + ' background activity(s).');
					pushRecordFn(reply.items);
					if (reply.next) {
						complete = false;
						getBackgroundActivities(pushRecordFn, pipeRunLog, pipe, done, reply.next);
					}
				}
				if (complete) {
					done();
				}
			}
		});
	};

	/**
	 * Fetch the user's friends (formerly known as 'street team') from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/friends} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 * @param [uri] - optional URI, used for paging. if not specified the default URI will be used
	 */
	var getFriends = function(pushRecordFn, pipeRunLog, pipe, done, uri) {
		pipeRunLog.info('Fetching friends.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.TeamFeed+json', (uri||runkeeperUris.team), function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching friends from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for friends request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				var complete = true;
				if (reply && reply.items) {
					pipeRunLog.info('Fetched ' + reply.items.length + ' friend(s).');
					pushRecordFn(reply.items);
					if (reply.next) {
						complete = false;
						getFriends(pushRecordFn, pipeRunLog, pipe, done, reply.next);
					}
				}
				if (complete) {
					done();
				}
			}
		});
	};

	/**
	 * Fetch the user's sleep measurements from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/sleep-sets} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 * @param [uri] - optional URI, used for paging. if not specified the default URI will be used
	 */
	var getSleepMeasurements = function(pushRecordFn, pipeRunLog, pipe, done, uri) {
		pipeRunLog.info('Fetching sleep measurements.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.SleepSetFeed+json', (uri||runkeeperUris.sleep), function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching sleep measurements from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for sleep measurements request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				var complete = true;
				if (reply && reply.items) {
					pipeRunLog.info('Fetched ' + reply.items.length + ' sleep measurement(s).');
					pushRecordFn(reply.items);
					if (reply.next) {
						complete = false;
						getSleepMeasurements(pushRecordFn, pipeRunLog, pipe, done, reply.next);
					}
				}
				if (complete) {
					done();
				}
			}
		});
	};

	/**
	 * Fetch the user's nutritional measurements from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/nutrition-sets} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 * @param [uri] - optional URI, used for paging. if not specified the default URI will be used
	 */
	var getNutritionalMeasurements = function(pushRecordFn, pipeRunLog, pipe, done, uri) {
		pipeRunLog.info('Fetching nutritional measurements.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.NutritionSetFeed+json', (uri||runkeeperUris.nutrition), function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching nutritional measurements from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for nutritional measurements request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				var complete = true;
				if (reply && reply.items) {
					pipeRunLog.info('Fetched ' + reply.items.length + ' nutritional measurement(s).');
					pushRecordFn(reply.items);
					if (reply.next) {
						complete = false;
						getNutritionalMeasurements(pushRecordFn, pipeRunLog, pipe, done, reply.next);
					}
				}
				if (complete) {
					done();
				}
			}
		});
	};

	/**
	 * Fetch the user's general measurements from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/general-measurement-sets} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 * @param [uri] - optional URI, used for paging. if not specified the default URI will be used
	 */
	var getGeneralMeasurements = function(pushRecordFn, pipeRunLog, pipe, done, uri) {
		pipeRunLog.info('Fetching general measurements.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.GeneralMeasurementSetFeed+json', (uri||runkeeperUris.general_measurements), function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching general measurements from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for general measurements request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				var complete = true;
				if (reply && reply.items) {
					pipeRunLog.info('Fetched ' + reply.items.length + ' general measurement(s).');
					pushRecordFn(reply.items);
					if (reply.next) {
						complete = false;
						getGeneralMeasurements(pushRecordFn, pipeRunLog, pipe, done, reply.next);
					}
				}
				if (complete) {
					done();
				}
			}
		});
	};

	/**
	 * Fetch the user's diabetes measurements from Runkeeper.
	 * See {@link https://runkeeper.com/developer/healthgraph/diabetes-sets} for more information.
	 * @param pushRecordFn - function to be invoked to push records through the pipeline
	 * @param pipeRunLog - a dedicated logger instance that is only available during data pipe runs
	 * @param pipe - data pipe configuration
	 * @param done(err) - callback function to be invoked after processing is complete (or a fatal error has been encountered)
	 * @param [uri] - optional URI, used for paging. if not specified the default URI will be used
	 */
	var getDiabetesMeasurements = function(pushRecordFn, pipeRunLog, pipe, done, uri) {
		pipeRunLog.info('Fetching diabetes measurements.');
		runkeeperClient.apiCall('GET', 'application/vnd.com.runkeeper.DiabetesFeed+json', (uri||runkeeperUris.diabetes), function(err, reply) {
			if(err) {
				pipeRunLog.error('Error fetching diabetes measurements from Runkeeper: ' + err);
				pipeRunLog.error('FFDC: Runkeeper client params: ');
				pipeRunLog.error(' ' + util.inspect(runkeeperClient,1));
				pipeRunLog.error('FFDC: Runkeeper reply for diabetes measurements request: ');
				pipeRunLog.error(' ' + util.inspect(reply,3));
				done(err);
			}
			else {
				var complete = true;
				if (reply && reply.items) {
					pipeRunLog.info('Fetched ' + reply.items.length + ' diabetes measurement(s).');
					pushRecordFn(reply.items);
					if (reply.next) {
						complete = false;
						getDiabetesMeasurements(pushRecordFn, pipeRunLog, pipe, done, reply.next);
					}
				}
				if (complete) {
					done();
				}
			}
		});
	};

}

//Extend event Emitter
util.inherits(oAuthRunkeeperConnector, connectorExt);

module.exports = new oAuthRunkeeperConnector();