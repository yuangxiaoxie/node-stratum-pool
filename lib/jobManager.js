var events = require('events');
var crypto = require('crypto');
var bignum = require('bignum');
var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');

//Unique extranonce per subscriber
var ExtraNonceCounter = function (configInstanceId) {
    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = instanceId << 27;
    this.next = function () {
        var extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };
    this.size = 4; //bytes
};

//Unique job per new block template
var JobCounter = function () {
    var counter = 0;
    this.next = function () {
        counter++;
        if (counter % 0xffffffffff === 0)
            counter = 1;
        return this.cur();
    };
    this.cur = function () {
        return counter.toString(16);
    };
};

var JobManager = module.exports = function JobManager(options) {
    var _this = this;
    var jobCounter = new JobCounter();
    var shareMultiplier = algos[options.coin.algorithm].multiplier;

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
    this.currentJob;
    this.validJobs = {};
    
    var hashDigest = algos[options.coin.algorithm].hash(options.coin);

    this.updateCurrentJob = function (rpcData) {
        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            options.extraNoncePlaceholder,
            options.recipients,
            options.address,
            options.poolHex,
            options.coin
        );

        _this.currentJob = tmpBlockTemplate;
        _this.emit('updatedBlock', tmpBlockTemplate, true);
        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
    };

    this.processTemplate = function (rpcData) {
        var isNewBlock = typeof(_this.currentJob) === 'undefined';
        if (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;
        }
        if (!isNewBlock) return false;

        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            options.extraNoncePlaceholder,
            options.recipients,
            options.address,
            options.poolHex,
            options.coin
        );
        
        this.currentJob = tmpBlockTemplate;
        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);
        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
        return true;
    };

    this.processShare = function (jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName) {
        var shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return {error: error, result: null};
        };

        var submitTime = Date.now() / 1000 | 0;
        var job = this.validJobs[jobId];

        if (typeof job === 'undefined' || job.jobId !== jobId) {
            return shareError([21, 'Job not found']);
        }

        if (nTime.length !== 8) {
            return shareError([20, 'Incorrect size of nTime']);
        }

        var nTimeInt = parseInt(util.reverseBuffer(new Buffer(nTime, 'hex')).toString('hex'), 16);
        if (nTimeInt > submitTime + 3600 || nTimeInt < job.rpcData.mintime) {
            return shareError([20, 'nTime out of range']);
        }

        if (extraNonce2.length / 2 !== job.extraNonce2Size) {
            return shareError([20, 'Incorrect size of extraNonce2']);
        }

        if (nonce.length !== 8) {
            return shareError([20, 'Incorrect size of nonce']);
        }

        if (!job.registerSubmit(extraNonce1, extraNonce2, nTime, nonce)) {
            return shareError([22, 'Duplicate share']);
        }

        var header = job.serializeHeader(extraNonce1, extraNonce2, nTime, nonce);
        var headerHash = hashDigest(header, nTimeInt);
        var headerBigNum = bignum.fromBuffer(headerHash, {endian: 'little', size: 32});

        var blockHash = null;
        var blockHex = null;

        var shareDiff = diff1 / headerBigNum.toNumber() * shareMultiplier;
        var blockDiffAdjusted = job.difficulty * shareMultiplier;

        if (headerBigNum.le(job.target)) {
            blockHex = job.serializeBlock(header).toString('hex');
            blockHash = util.reverseBuffer(hashDigest(header, nTimeInt)).toString('hex');
        } else {
            if (shareDiff / difficulty < 0.99) {
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                } else {
                    return shareError([23, 'Low difficulty share of ' + shareDiff]);
                }
            }
        }

        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.reward,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash
        }, blockHex);
        
        return {result: true, error: null, blockHash: blockHash};
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
